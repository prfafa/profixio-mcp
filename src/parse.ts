import * as cheerio from "cheerio";
import { BASE } from "./client.js";

const clean = (s: string) => s.replace(/\s+/g, " ").trim();

const decodeEntities = (s: string) =>
  s
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");

/** Pull every `JSON.parse('...')` payload embedded in Alpine attributes. */
export function embeddedJson(html: string): any[] {
  const decoded = decodeEntities(html);
  const out: any[] = [];
  for (const m of decoded.matchAll(/JSON\.parse\('((?:[^'\\]|\\.)*)'\)/g)) {
    try {
      // The payload is a single-quoted JS string literal; re-wrap it as a JSON string to unescape it.
      const str = JSON.parse(`"${m[1].replace(/\\'/g, "'").replace(/"/g, '\\"')}"`) as string;
      out.push(JSON.parse(str));
    } catch {
      /* ignore non-JSON payloads */
    }
  }
  return out;
}

export interface LinkItem {
  id: string;
  name: string;
  url: string;
}

export function links(html: string, pattern: RegExp): LinkItem[] {
  const $ = cheerio.load(html);
  const seen = new Map<string, LinkItem>();
  $("a[href]").each((_, a) => {
    const href = $(a).attr("href")!;
    const m = href.match(pattern);
    if (!m) return;
    const name = clean($(a).text());
    const prev = seen.get(m[1]);
    if (!prev || (!prev.name && name)) seen.set(m[1], { id: m[1], name, url: href });
  });
  return [...seen.values()];
}

// ---- match lists (competition schedule, team schedule, district day list) ----

/** Unix seconds → "2026-11-01 15:00" in Swedish local time. */
const stockholm = (sec: number) =>
  new Date(sec * 1000).toLocaleString("sv-SE", { timeZone: "Europe/Stockholm", dateStyle: "short", timeStyle: "short" });

const MONTHS: Record<string, string> = {
  jan: "01", feb: "02", mar: "03", apr: "04", maj: "05", may: "05", jun: "06",
  jul: "07", aug: "08", sep: "09", okt: "10", oct: "10", nov: "11", dec: "12",
};

export interface MatchRow {
  matchId: number;
  kickoff: string | null; // local Swedish time, "YYYY-MM-DD HH:MM"
  round: string | null;
  division: string | null;
  venue: string | null;
  home: { name: string; teamId: string | null };
  away: { name: string; teamId: string | null };
  score: string | null;
  url: string;
}

export const countMatchRows = (html: string) => new Set(html.match(/listkamp_\d+/g) ?? []).size;

export function parseMatchList(html: string): MatchRow[] {
  const rows: MatchRow[] = [];
  const parts = html.split(/<li wire:key="listkamp_/).slice(1);
  const seen = new Set<number>();
  let day: string | null = null; // date headings only appear on the first match of each day
  for (const part of parts) {
    const heading = part.match(/^\d+">\s*(?:<[^>]*>\s*|<!--[^>]*-->\s*)*[A-ZÅÄÖ][a-zåäö]+dag\s+(\d{1,2}) ([a-zé]{3})[a-z]* (\d{4})/);
    if (heading) day = `${heading[3]}-${MONTHS[heading[2]] ?? "??"}-${heading[1].padStart(2, "0")}`;
    const clock = part.match(/\d{1,2} [a-zé]{3}[a-z]* • (\d{2}:\d{2})/)?.[1];
    const id = Number(part.match(/^(\d+)/)?.[1]);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const reg = part.match(/registerMatch\(\s*\d+,\s*'[^']*',\s*\{([\s\S]*?)\}\s*\)/)?.[1] ?? "";
    const hg = reg.match(/homegoals:\s*'([^']*)'/)?.[1] ?? "";
    const ag = reg.match(/awaygoals:\s*'([^']*)'/)?.[1] ?? "";
    const kick = Number(part.match(/kickoff:\s*(\d+)/)?.[1]);
    const $ = cheerio.load(`<li>${part}`);
    const teams = $("a[href*='/teams/']")
      .toArray()
      .map((a) => ({ name: clean($(a).text()), teamId: $(a).attr("href")!.match(/\/teams\/(\d+)/)?.[1] ?? null }));
    const roundDiv = $("div")
      .toArray()
      .map((d) => clean($(d).text()))
      .find((t) => /^Omgång \d+/.test(t));
    const division = $("div.hidden").filter((_, d) => /lx-wider:inline-block/.test($(d).attr("class") ?? "")).first().text();
    rows.push({
      matchId: id,
      kickoff: kick ? stockholm(kick) : day ? `${day}${clock ? ` ${clock}` : ""}` : null,
      round: roundDiv?.match(/Omgång \d+/)?.[0] ?? null,
      division: clean(division) || null,
      venue: clean($("a[href*='/facility/']").first().text()) || null,
      home: teams[0] ?? { name: "", teamId: null },
      away: teams[1] ?? { name: "", teamId: null },
      score: hg !== "" && ag !== "" ? `${hg}-${ag}` : null,
      url: `${BASE}/lx/match/${id}`,
    });
  }
  return rows;
}

// ---- standings ----

export interface StandingsTable {
  group: string;
  phase: string | null;
  rows: Record<string, string>[];
}

export function parseStandings(html: string): StandingsTable[] {
  const $ = cheerio.load(html);
  const out: StandingsTable[] = [];
  $("table").each((_, t) => {
    const headers = $(t)
      .find("thead th")
      .toArray()
      .map((th) => clean($(th).text()));
    const rows = $(t)
      .find("tbody tr")
      .toArray()
      .map((tr) => {
        const cells = $(tr).find("td").toArray();
        const row: Record<string, string> = {};
        cells.forEach((td, i) => {
          const key = headers[i] || `col${i}`;
          const teamLink = $(td).find("a[href*='/teams/']").first();
          row[key] = teamLink.length
            ? teamLink.find("[title]").attr("title") ?? clean(teamLink.find(".sr-only").text() || teamLink.text())
            : clean($(td).text());
          if (teamLink.length) row.teamId = teamLink.attr("href")!.match(/\/teams\/(\d+)/)?.[1] ?? "";
        });
        return row;
      })
      .filter((r) => Object.values(r).some(Boolean));
    // Heading lives in the region wrapper: <h2><a>P19 Nivå 1 Öst | <span>Grundserie</span></a></h2>
    const h2 = $(t).closest("[role=region]").find("h2").first();
    const phase = clean(h2.find("span").text()) || null;
    const group = clean(h2.text()).replace(/\s*\|\s*[^|]*$/, "");
    out.push({ group, phase, rows });
  });
  return out;
}

// ---- match protocol ----

export interface LineupEntry {
  number: string;
  name: string;
  badges: string[]; // e.g. "MV" (goalkeeper), "RMV", "K" (captain); officials carry their letter
  goals: number;
  suspensions: number; // 2-minute suspensions ("Bestr.")
  playerUrl: string | null;
  official: boolean;
}

export function parseMatchPage(html: string, matchId: number) {
  const $ = cheerio.load(html);
  const json = embeddedJson(html);
  const live = json.find((j) => j && j.kampId === matchId && Array.isArray(j.events));
  const gamestate = json.find((j) => j && "headerstate" in j);
  const setup = json.find((j) => j && "period_length" in j);

  const teamLinks = links(html, /\/competition\/[^/]+\/teams\/(\d+)/);
  const teamName = (id: unknown) => teamLinks.find((t) => t.id === String(id))?.name ?? null;

  const text = clean($("body").text());
  const date = text.match(/\b(\d{4}-\d{2}-\d{2})\b\s+(\d{2}:\d{2})/);
  // Header text, e.g. "Hylte Halmstad VBK 3 - 0 (25-17) (25-8) (25-14) Slut"
  const headerScore = text.match(/\s(\d+) - (\d+)((?: \(\d+-\d+\))*)\s/);
  const setScores = headerScore?.[3] ? [...headerScore[3].matchAll(/\((\d+-\d+)\)/g)].map((m) => m[1]) : null;
  // "Matchinfo" section: label/value pairs in reading order.
  const info = (label: string, next: string) =>
    text.match(new RegExp(`${label} (.+?) (?:${next})`))?.[1]?.trim() ?? null;
  const competitionLink = links(html, /\/lx\/competition\/([a-zA-Z0-9]+)(?:$|\?)/)[0] ?? null;

  // Lineups: each team's list is a <ul> of <li wire:key="lineup-...">.
  const lineups: LineupEntry[][] = [];
  $("ul").each((_, ul) => {
    const items = $(ul).children("li[wire\\:key^='lineup-']");
    if (!items.length) return;
    lineups.push(
      items.toArray().map((li) => {
        const cells = $(li).find("> a > span, > div > span, > span").toArray();
        const cell = (i: number) => clean($(cells[i] ?? "").text());
        const nameCell = $(cells[2] ?? "");
        const nameParts = nameCell.children("span").toArray().map((x) => clean($(x).text()));
        const number = cell(1);
        return {
          number,
          name: nameParts[0] ?? cell(2),
          badges: nameParts.slice(1).filter((b) => b && b !== number),
          goals: Number(cell(3)) || 0,
          suspensions: Number(cell(4)) || 0,
          playerUrl: $(li).find("a[href*='/player/']").attr("href") ?? null,
          official: /^[A-Z]$/.test(number),
        };
      }),
    );
  });

  const events = ((live?.events ?? []) as any[])
    .filter((e) => e.name !== "Spelare aktiverad")
    .map((e) => ({
      time: e.time,
      period: e.period,
      side: e.side,
      type: String(e.name).replace(/%%omgang%%/g, String(e.period)),
      player: e.playerName ? `${e.playerNo ?? ""} ${e.playerName}`.trim() : null,
      assist: e.assistName ? `${e.assistNo ?? ""} ${e.assistName}`.trim() : null,
      score: e.scoreH != null && e.scoreA != null ? `${e.scoreH}-${e.scoreA}` : null,
      expulsionMinutes: e.expulsionMinutes || undefined,
      comment: e.comment || undefined,
    }))
    .reverse(); // page lists newest first

  return {
    matchId,
    url: `https://www.profixio.com/app/lx/match/${matchId}`,
    competition: competitionLink ? { slug: competitionLink.id, name: competitionLink.name } : null,
    date: date ? `${date[1]} ${date[2]}` : null,
    round: text.match(/Omgång \d+/)?.[0] ?? null,
    matchNumber: text.match(/Matchnummer:\s*([\d ]+\d)/)?.[1] ?? null,
    venue:
      clean($("a[href*='/facility/']").first().text()) ||
      html.match(/M15 10\.5a3 3 0 1 1-6 0[\s\S]*?<\/svg>\s*<span[^>]*>([^<]+)<\/span>/)?.[1]?.trim() ||
      null,
    status: gamestate?.headerstate ?? live?.state ?? null,
    underReview: /Protokollet är under granskning/.test(text) || gamestate?.awaitingReview || false,
    home: { teamId: live?.homeWebid ?? null, name: teamName(live?.homeWebid) },
    away: { teamId: live?.awayWebid ?? null, name: teamName(live?.awayWebid) },
    score: gamestate?.currentScore
      ? `${gamestate.currentScore.homeGoals}-${gamestate.currentScore.awayGoals}`
      : headerScore
        ? `${headerScore[1]}-${headerScore[2]}`
        : null,
    setScores,
    referees: info("Domare", "Matchdokument|Tävlingsledare|Sekretariat|Lineups|$"),
    organizer: info("Arrangerande förening", "Tävlingsadministratör|Tävling"),
    periods: setup ? { count: setup.periods, length: setup.period_length } : null,
    lineups: { home: lineups[0] ?? [], away: lineups[1] ?? [] },
    timeoutsUsed: live?.timeouts
      ? {
          home: live.timeouts.home?.balls?.filter((b: any) => b.marked).length ?? 0,
          away: live.timeouts.away?.balls?.filter((b: any) => b.marked).length ?? 0,
        }
      : null,
    events,
  };
}
