// Minimal HTTP + Livewire client for the public Profixio app (www.profixio.com/app).
// Profixio has no public JSON API; pages are server-rendered Livewire components,
// some of them lazy-loaded. We fetch the page, then replay Livewire calls over HTTP.

export const BASE = "https://www.profixio.com/app";
const ORIGIN = new URL(BASE).origin;
const UA = "Mozilla/5.0 (profixio-mcp; read-only)";
const TIMEOUT_MS = 20_000;

/** Only ever talk to Profixio, even if a page or redirect points somewhere else. */
function assertProfixio(url: string): string {
  if (new URL(url, ORIGIN).origin !== ORIGIN) throw new Error(`Refusing non-Profixio URL: ${url}`);
  return new URL(url, ORIGIN).href;
}

export interface Page {
  url: string;
  html: string;
  csrf: string;
  updateUri: string;
  cookies: string;
}

export interface Snapshot {
  raw: string; // exact JSON string, must be sent back unmodified
  name: string;
  start: number; // offset in page html
  end: number;
}

const decodeEntities = (s: string) =>
  s
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");

function mergeCookies(existing: string, res: Response): string {
  const jar = new Map<string, string>();
  for (const part of existing.split("; ").filter(Boolean)) {
    const i = part.indexOf("=");
    jar.set(part.slice(0, i), part.slice(i + 1));
  }
  for (const c of res.headers.getSetCookie()) {
    const kv = c.split(";")[0];
    const i = kv.indexOf("=");
    jar.set(kv.slice(0, i), kv.slice(i + 1));
  }
  return [...jar].map(([k, v]) => `${k}=${v}`).join("; ");
}

export async function getPage(pathOrUrl: string): Promise<Page> {
  const url = assertProfixio(pathOrUrl.startsWith("http") ? pathOrUrl : `${BASE}/${pathOrUrl.replace(/^\//, "")}`);
  const res = await fetch(url, {
    headers: { "User-Agent": UA, "Accept-Language": "sv,en" },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`Profixio returned HTTP ${res.status} for ${url}`);
  assertProfixio(res.url);
  const html = await res.text();
  const csrf = html.match(/name="csrf-token" content="([^"]+)"/)?.[1] ?? "";
  const updateUri = assertProfixio(html.match(/data-update-uri="([^"]+)"/)?.[1] ?? `${BASE}/livewire/update`);
  return { url: res.url, html, csrf, updateUri, cookies: mergeCookies("", res) };
}

export function snapshots(html: string): Snapshot[] {
  const out: Snapshot[] = [];
  const re = /wire:snapshot="([^"]+)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    const raw = decodeEntities(m[1]);
    const name = raw.match(/"name":"([^"]+)"/)?.[1] ?? "";
    out.push({ raw, name, start: m.index, end: re.lastIndex });
  }
  return out;
}

export function findSnapshot(page: Page, name: string): Snapshot {
  const snap = snapshots(page.html).find((s) => s.name === name);
  if (!snap) throw new Error(`Component ${name} not found on ${page.url}`);
  return snap;
}

interface Call {
  method: string;
  params?: unknown[];
}

/** POST a Livewire update for one component; returns the re-rendered component HTML. */
export async function livewire(
  page: Page,
  snapshot: string,
  updates: Record<string, unknown> = {},
  calls: Call[] = [],
): Promise<{ html: string; snapshot: string }> {
  const body = {
    _token: page.csrf,
    components: [
      { snapshot, updates, calls: calls.map((c) => ({ path: "", method: c.method, params: c.params ?? [] })) },
    ],
  };
  const res = await fetch(page.updateUri, {
    method: "POST",
    headers: {
      "User-Agent": UA,
      "Content-Type": "application/json",
      "X-Livewire": "1",
      "X-CSRF-TOKEN": page.csrf,
      Referer: page.url,
      Cookie: page.cookies,
    },
    body: JSON.stringify(body),
    redirect: "error",
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`Livewire update failed: HTTP ${res.status}`);
  const json = (await res.json()) as { components: { snapshot: string; effects: { html?: string } }[] };
  const c = json.components[0];
  return { html: c?.effects?.html ?? "", snapshot: c?.snapshot ?? snapshot };
}

/** Render a lazy-loaded component (one that shows a placeholder until scrolled into view). */
export async function lazyLoad(page: Page, name: string, updates: Record<string, unknown> = {}): Promise<string> {
  const all = snapshots(page.html);
  const idx = all.findIndex((s) => s.name === name);
  if (idx < 0) throw new Error(`Component ${name} not found on ${page.url}`);
  const snap = all[idx];
  const next = all[idx + 1]?.start ?? page.html.length;
  const param = page.html.slice(snap.end, next).match(/__lazyLoad\(&#039;([^&]+)&#039;\)/)?.[1];
  // Not lazy on this page: either it's already rendered, or we just re-render with updates.
  const hasUpdates = Object.keys(updates).length > 0;
  if (!param) {
    if (!hasUpdates) return page.html.slice(snap.start, next);
    return (await livewire(page, snap.raw, updates)).html;
  }
  const loaded = await livewire(page, snap.raw, {}, [{ method: "__lazyLoad", params: [param] }]);
  if (!hasUpdates) return loaded.html;
  // Apply property changes (filters, limits) on the now-mounted component.
  return (await livewire(page, loaded.snapshot, updates)).html;
}

/**
 * Long lists render 25 rows plus a lazy "infinite-scroll-next-page" child that loads the
 * next chunk when scrolled into view. Follow that chain until `want` rows or the end.
 */
export async function followInfinite(page: Page, html: string, countRows: (h: string) => number, want: number) {
  let all = html;
  let chunk = html;
  for (let guard = 0; guard < 40 && countRows(all) < want; guard++) {
    const snap = snapshots(chunk).find((s) => s.name === "infinite-scroll-next-page");
    if (!snap) break;
    const param = chunk.slice(snap.end).match(/__lazyLoad\(&#039;([^&]+)&#039;\)/)?.[1];
    if (!param) break;
    chunk = (await livewire(page, snap.raw, {}, [{ method: "__lazyLoad", params: [param] }])).html;
    if (!chunk) break;
    all += chunk;
  }
  return all;
}
