# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

A GitHub Action (`action.yml`) that fetches Steam gameplay data and writes a structured JSON file. It tracks playtime snapshots, computes daily deltas, and maintains a rolling history. The action can auto-commit the output file to the repository.

## Commands

```bash
# Bundle src/index.js into dist/index.js (must run before testing the action)
npm run build

# Run tests (Node built-in test runner — no test file exists yet)
npm run test
```

The action entry point is `dist/index.js`. Always rebuild after changing `src/index.js`.

## Architecture

Everything lives in `src/index.js`. There are no modules — it's a single-file action.

**Data flow:**
1. Reads inputs from `action.yml` via `@actions/core`
2. Loads existing JSON output file (if present) to get previous snapshot
3. Fetches owned games and player summary from Steam Web API
4. Computes playtime deltas (current snapshot vs previous snapshot)
5. Builds `recentlyPlayed`, `stats`, and rolling `dailyLog`
6. Writes the JSON output file
7. Sets `changes_detected` output and optionally auto-commits

**Output JSON shape:**
```js
{
  lastUpdated,       // ISO timestamp
  profile,           // steamId, personaName, avatarUrl, profileUrl
  recentlyPlayed,    // top-N games with artworkUrls and playtimeByPlatform
  stats,             // aggregate counts and totals
  dailyLog,          // rolling window (default 90 days) of per-day deltas
  snapshot           // { date, games: { [appId]: playtimeForever } }
}
```

**Snapshot model:** The `snapshot` field stores playtime-forever values from the previous run. Deltas are computed by diffing current vs snapshot. The daily log entry for today is replaced on re-runs (idempotent).

**Artwork URLs:** Generated from predictable Akamai CDN patterns — no extra API calls needed.

**Auto-commit:** Runs `git` directly via shell commands at the end of `run()` unless `skip_commit` is `true`.

## Key Constraints

- **No TypeScript** — plain JavaScript (Node 20)
- **No linting or formatting tooling** configured
- **esbuild bundles** `@actions/core` and all dependencies into `dist/index.js`; the action runtime only sees `dist/`
- Test infrastructure (Node `--test`) is wired in `package.json` but no test file exists yet (`src/index.test.js`)
