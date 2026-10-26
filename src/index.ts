#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { findSnapshot, followInfinite, getPage, lazyLoad, livewire } from "./client.js";
import { countMatchRows, links, parseMatchList, parseMatchPage, parseStandings } from "./parse.js";

const server = new McpServer({ name: "profixio", version: "0.1.0" });

const ok = (data: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] });

/** Accept "leagueid27971", a full competition URL, or a team URL. */
const competitionSlug = (s: string) => s.match(/competition\/([a-zA-Z0-9]+)/)?.[1] ?? s.match(/app\/([a-zA-Z0-9]+)\/teams/)?.[1] ?? s.trim();

const matchFilter = z
  .enum(["upcoming", "played", "all"])
  .default("all")
  .describe("upcoming = not yet played, played = finished, all = both");

server.registerTool(
  "list_federations",
  {
    title: "List federations",
    description: "List the sports federations on Profixio (e.g. SHF = Svenska Handbollförbundet, SVBF = volleyboll). Start here to browse.",
    inputSchema: {},
  },
  async () => {
    const page = await getPage("tournaments");
    return ok(links(page.html, /\/app\/lx\/([A-Za-z]+)$/).map((l) => ({ code: l.id, name: l.name || l.id })));
  },
);

server.registerTool(
  "list_districts",
  {
    title: "List districts",
    description: "List the districts/regions of a federation, e.g. SHF → HF Öst, HF Väst.",
    inputSchema: { federation: z.string().describe("Federation code, e.g. SHF") },
  },
  async ({ federation }) => {
    const page = await getPage(`lx/${federation}`);
    return ok(links(page.html, /\/district\/(\d+)$/).map((l) => ({ districtId: l.id, name: l.name })));
  },
);

server.registerTool(
  "list_competitions",
  {
    title: "List competitions",
    description:
      "List the competitions (series/leagues) for the current season, either federation-wide (national series) or in one district. Returns slugs used by the other tools.",
    inputSchema: {
      federation: z.string().describe("Federation code, e.g. SHF"),
      districtId: z.string().optional().describe("District id from list_districts; omit for federation-level competitions"),
      search: z.string().optional().describe("Case-insensitive filter on competition name, e.g. 'P19'"),
    },
  },
  async ({ federation, districtId, search }) => {
    const path = districtId ? `lx/${federation}/district/${districtId}` : `lx/${federation}`;
    const page = await getPage(`${path}?t=competitions`);
    let list = links(page.html, /\/lx\/competition\/([a-zA-Z0-9]+)$/).map((l) => ({ slug: l.id, name: l.name }));
    if (search) list = list.filter((c) => c.name.toLowerCase().includes(search.toLowerCase()));
    return ok(list);
  },
);

server.registerTool(
  "search_teams",
  {
    title: "Search teams",
    description: "Search all of Profixio for teams by name. Returns team ids with the competition each team plays in (newest seasons first is not guaranteed).",
    inputSchema: { query: z.string().describe("Team or club name, e.g. 'Tyresö'") },
  },
  async ({ query }) => {
    const page = await getPage("search");
    const snap = findSnapshot(page, "admin.global-search");
    const { html } = await livewire(page, snap.raw, { filter: query, tab: "teams" });
    const teams = links(html, /\/app\/(?:lx\/competition\/)?([a-zA-Z0-9]+\/teams\/\d+)/).map((l) => {
      const [slug, , teamId] = l.id.split("/");
      return { teamId, name: l.name, competitionSlug: slug };
    });
    return ok(teams);
  },
);

server.registerTool(
  "get_competition_matches",
  {
    title: "Competition matches",
    description: "Schedule and results for a competition. Each match has a matchId to pass to get_match_protocol.",
    inputSchema: {
      competition: z.string().describe("Competition slug (e.g. leagueid27971) or URL"),
      filter: matchFilter,
      limit: z.number().int().min(1).max(500).default(100),
    },
  },
  async ({ competition, filter, limit }) => {
    const page = await getPage(`lx/competition/${competitionSlug(competition)}?t=matches`);
    const first = await lazyLoad(page, "lx.competition.schedule", { matchFilter: filter });
    const html = await followInfinite(page, first, countMatchRows, limit);
    return ok(parseMatchList(html).slice(0, limit));
  },
);

server.registerTool(
  "get_team_matches",
  {
    title: "Team matches",
    description: "All matches for one team in a competition. Use search_teams or get_competition_matches to find the teamId.",
    inputSchema: {
      competition: z.string().describe("Competition slug (e.g. leagueid27971) or URL"),
      teamId: z.string(),
      filter: matchFilter,
    },
  },
  async ({ competition, teamId, filter }) => {
    const page = await getPage(`lx/competition/${competitionSlug(competition)}/teams/${teamId}`);
    const html = await lazyLoad(page, "lx.team.schedule", { matchFilter: filter });
    return ok(parseMatchList(html));
  },
);

server.registerTool(
  "get_standings",
  {
    title: "Standings",
    description: "League table(s) for a competition. One competition can have several groups.",
    inputSchema: { competition: z.string().describe("Competition slug (e.g. leagueid27971) or URL") },
  },
  async ({ competition }) => {
    const page = await getPage(`lx/competition/${competitionSlug(competition)}?t=table`);
    return ok(parseStandings(await lazyLoad(page, "lx.competition.tables")));
  },
);

server.registerTool(
  "get_matches_by_date",
  {
    title: "Matches on a date",
    description: "All matches in a district on a given day.",
    inputSchema: {
      federation: z.string().describe("Federation code, e.g. SHF"),
      districtId: z.string(),
      date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe("YYYY-MM-DD"),
    },
  },
  async ({ federation, districtId, date }) => {
    const page = await getPage(`lx/${federation}/district/${districtId}`);
    const snap = findSnapshot(page, "lx.fed-match-list");
    const { html } = await livewire(page, snap.raw, { day: date });
    return ok(parseMatchList(await followInfinite(page, html, countMatchRows, 500)));
  },
);

server.registerTool(
  "get_match_protocol",
  {
    title: "Match protocol",
    description:
      "The match protocol (matchprotokoll): teams, result, venue, lineups with goals and suspensions per player, officials, and the full event log (goals, 7m, suspensions, timeouts).",
    inputSchema: { matchId: z.union([z.number(), z.string()]).describe("Match id, or a profixio.com/app/lx/match/<id> URL") },
  },
  async ({ matchId }) => {
    const id = Number(String(matchId).match(/(\d+)\D*$/)?.[1]);
    if (!id) throw new Error("Invalid match id");
    const page = await getPage(`lx/match/${id}`);
    return ok(parseMatchPage(page.html, id));
  },
);

await server.connect(new StdioServerTransport());
