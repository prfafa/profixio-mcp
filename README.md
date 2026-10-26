# profixio-mcp

Read-only MCP server for [Profixio](https://www.profixio.com/app): competitions, schedules, standings and match protocols (matchprotokoll) for Swedish federations on Profixio (handboll, volleyboll, bandy, basket, …).

> Unofficial. Not affiliated with or endorsed by Profixio or any federation.

Profixio has no public API. This reads the public site and replays its Livewire calls over HTTP. No login, no browser, no credentials. If Profixio changes its markup, the parsers in `src/parse.ts` are where things break.

## Tools

| Tool | What |
|---|---|
| `list_federations` | SHF, SVBF, SBF, SBBF, … |
| `list_districts` | Districts in a federation |
| `list_competitions` | Competitions this season, federation-wide or per district |
| `search_teams` | Find a team by name across Profixio |
| `get_competition_matches` | Schedule/results, `upcoming` / `played` / `all` |
| `get_team_matches` | One team's matches in a competition |
| `get_standings` | League tables |
| `get_matches_by_date` | All matches in a district on a day |
| `get_match_protocol` | Result, set scores, venue, lineups, officials, timeouts, full event log, referees when published |

## Install

Requires Node 20+.

```sh
git clone https://github.com/prfafa/profixio-mcp.git
cd profixio-mcp
npm install && npm run build
```

Claude Code:

```sh
claude mcp add --scope user profixio -- node /absolute/path/to/profixio-mcp/dist/index.js
```

Other MCP clients (Claude Desktop, Cursor, …):

```json
{
  "mcpServers": {
    "profixio": {
      "command": "node",
      "args": ["/absolute/path/to/profixio-mcp/dist/index.js"]
    }
  }
}
```

## Known limitations

- `search_teams` can return teams from earlier seasons only. Use `list_competitions` or `get_matches_by_date` to find current-season teams.
- Lineup columns follow the handball layout (`goals`, `suspensions`). For other sports, like basketball, they can be shifted. The `events` log is reliable.
- `timeoutsUsed` can disagree with the timeouts in `events`.

## Security

- Read-only. No login, no credentials, nothing written to disk. Requests are restricted to `https://www.profixio.com`, also after redirects.
- Tool output is scraped public content (team names, player names, comments). Treat it as untrusted data, not as instructions, like any web content you give an LLM.
- Report vulnerabilities privately, see [SECURITY.md](SECURITY.md).

## Be nice to Profixio

Every tool call makes one or a few requests to profixio.com. Don't loop it or use it for bulk scraping.

## License

[MIT](LICENSE)
