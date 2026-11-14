import { domain, type Source } from './memory.ts';

// The book is the shared source ledger for one turn: every URL the model has
// seen, numbered in the order first seen.
export type Book = Map<string, Source & { opened: boolean; text: string }>;

export type ToolResult = { text: string; ok: number; failed: number; domains: string[] };

export type Tools = {
  webSearch(args: { queries: string[]; since?: string }, book: Book): Promise<ToolResult>;
  openPage(
    args: { urls: string[]; focus?: string },
    book: Book,
    live: boolean,
    maxChars: number
  ): Promise<ToolResult>;
};

// The one tool the model sees. Queries search, urls read pages, and both can
// ride in the same call; the harness runs them in parallel.
export const TOOL_SCHEMAS = [
  {
    type: 'function',
    function: {
      name: 'web_search',
      description:
        'Search the web and read pages, in parallel, in one call. Pass queries, urls, or both.' +
        ' queries: each runs on its own, so put every separate thing you need to know in as its own query.' +
        ' Returns up to 6 results per query, numbered for citation, each with its URL, publish date and short' +
        ' excerpts from a cached copy of the page. Excerpts are enough to choose which pages to read and to answer' +
        ' facts that do not change. They can be out of date or cut off.' +
        ' urls: reads up to 5 pages. This is how you get a current reading. Without focus you get the first part' +
        ' of each page, which suits articles and announcements. With focus you get only the passages about it,' +
        ' which suits long pages where you need one detail, such as pricing tables, docs and changelogs.' +
        ' Each page comes back marked live or cached copy. A FAILED page did not load, so use another source for it.',
      parameters: {
        type: 'object',
        properties: {
          queries: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 8 },
          urls: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 5 },
          since: {
            type: 'string',
            description:
              'YYYY-MM-DD, applies to queries only. Only for news or changes after a point in time' +
              ' ("this week", "since Monday"). It hides everything published earlier, including profiles,' +
              ' docs and pricing pages, so leave it out for normal lookups.',
          },
          focus: {
            type: 'string',
            description:
              'Applies to urls only. The detail to pull out, phrased the way the page would state it,' +
              ' e.g. "Pro plan monthly price per user".',
          },
        },
      },
    },
  },
];

// Adds a source to the book, or appends more text to the one already there.
function addSource(
  book: Book,
  url: string,
  title: string,
  opened: boolean,
  text: string,
  at: Date
): Source {
  let s = book.get(url);
  if (!s) {
    s = {
      n: book.size + 1,
      url,
      title: title || domain(url),
      fetched_at: at.toISOString(),
      opened,
      text: '',
    };
    book.set(url, s);
  }
  if (opened) s.opened = true;
  s.text += `\n${text}`;
  return s;
}

// POST to the Exa API. Retries once on a network error or a 5xx.
async function exa(path: string, body: object, key: string): Promise<any> {
  for (let attempt = 0; ; attempt++) {
    let res: Response;
    try {
      res = await fetch(`https://api.exa.ai${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': key },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(10_000),
      });
    } catch (e) {
      if (attempt === 0) continue;
      throw e;
    }
    if (res.ok) return res.json();
    if (res.status >= 500 && attempt === 0) continue;
    throw new Error(`Exa ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }
}

export function makeExaTools(key: string, clock = () => new Date()): Tools {
  return {
    // One Exa /search per query, all in parallel. Hits are numbered into the
    // book and rendered as blocks the model can cite, grouped under the query
    // that found them. Fewer results per query as the query count grows, so a
    // wide search stays readable.
    async webSearch({ queries, since }, book) {
      const numResults = queries.length <= 2 ? 6 : queries.length <= 5 ? 4 : 3;
      const settled = await Promise.allSettled(
        queries.map((query) =>
          exa(
            '/search',
            {
              query,
              type: 'lite',
              numResults,
              contents: { highlights: true },
              ...(since ? { startPublishedDate: `${since}T00:00:00.000Z` } : {}),
            },
            key
          )
        )
      );

      const seen = new Set<string>();
      const groups: string[] = [];
      let failed = 0;

      for (let i = 0; i < settled.length; i++) {
        const r = settled[i];
        const head = `## Query: "${queries[i]}"`;
        if (r.status === 'rejected') {
          failed++;
          groups.push(`${head}\nFailed: ${(r.reason as Error).message}`);
          continue;
        }
        const blocks: string[] = [];
        for (const hit of r.value.results ?? []) {
          const known = book.get(hit.url);
          if (seen.has(hit.url)) {
            // same URL across queries: first excerpt wins, later queries point back
            if (known) blocks.push(`[${known.n}] (same page as above)`);
            continue;
          }
          seen.add(hit.url);
          const excerpt = (hit.highlights ?? []).join(' … ');
          const s = addSource(book, hit.url, hit.title, false, excerpt, clock());
          const date = hit.publishedDate
            ? `published ${hit.publishedDate.slice(0, 10)}`
            : 'no publish date';
          blocks.push(`[${s.n}] ${s.title}\n${hit.url} (${date})\n${excerpt}`);
        }
        groups.push(`${head}\n${blocks.join('\n\n') || 'No results.'}`);
      }

      return {
        text: groups.join('\n\n'),
        ok: seen.size,
        failed,
        domains: [...new Set([...seen].map(domain))],
      };
    },

    // Reads one or more pages. With `focus`, Exa returns only the relevant
    // highlights instead of the full text. Pages cited in an earlier turn are
    // re-fetched live so old figures can be re-checked; any other page is
    // re-crawled when Exa's copy is older than a day.
    async openPage({ urls, focus }, book, live, maxChars) {
      let res: any;
      try {
        res = await exa(
          '/contents',
          {
            urls,
            ...(focus
              ? { highlights: { query: focus, maxCharacters: 2000 } }
              : { text: { maxCharacters: maxChars } }),
            maxAgeHours: live ? 0 : 24,
          },
          key
        );
      } catch (e) {
        return {
          text: `Reading pages failed: ${(e as Error).message}`,
          ok: 0,
          failed: urls.length,
          domains: [],
        };
      }

      const pages = new Map<string, any>((res.results ?? []).map((p: any) => [p.id ?? p.url, p]));
      const blocks: string[] = [];
      let ok = 0;

      for (const st of res.statuses ?? urls.map((id) => ({ id, status: 'success' }))) {
        const page = pages.get(st.id);
        if (st.status !== 'success' || !page) {
          blocks.push(`FAILED: ${st.id} (${st.error?.tag ?? 'no content'})`);
          continue;
        }
        ok++;
        const body: string = focus ? (page.highlights ?? []).join(' … ') : (page.text ?? '');
        const cut =
          !focus && body.length >= maxChars
            ? `\n[Cut off at ${maxChars} characters. Open it again with a focus to reach a detail further down.]`
            : '';
        const s = addSource(book, page.url ?? st.id, page.title, true, body, clock());
        const how = st.source === 'crawled' ? 'live' : 'cached copy';
        const date = page.publishedDate
          ? `published ${page.publishedDate.slice(0, 10)}`
          : 'no publish date';
        blocks.push(`[${s.n}] ${s.title}\n${s.url} (${date}, ${how})\n${body}${cut}`);
      }

      return { text: blocks.join('\n\n'), ok, failed: urls.length - ok, domains: [] };
    },
  };
}
