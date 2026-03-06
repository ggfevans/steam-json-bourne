const core = require('@actions/core');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

// ---------------------------------------------------------------------------
// Steam Web API helpers
// ---------------------------------------------------------------------------

const STEAM_API_BASE = 'https://api.steampowered.com';

async function steamGet(iface, method, version, params) {
  const url = new URL(`${STEAM_API_BASE}/${iface}/${method}/${version}/`);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null) url.searchParams.set(k, v);
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 30_000);
  let res;
  try {
    res = await fetch(url, { signal: ctrl.signal });
  } catch (err) {
    if (err.name === 'AbortError') throw new Error(`Steam API ${method} timed out after 30s`);
    throw err;
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) throw new Error(`Steam API ${method} returned ${res.status}: ${await res.text()}`);
  return res.json();
}

async function getOwnedGames(apiKey, steamId, includeFree) {
  const data = await steamGet('IPlayerService', 'GetOwnedGames', 'v1', {
    key: apiKey,
    steamid: steamId,
    include_appinfo: 1,
    include_played_free_games: includeFree ? 1 : 0,
    format: 'json',
  });
  return data?.response?.games ?? [];
}

async function getPlayerSummary(apiKey, steamId) {
  const data = await steamGet('ISteamUser', 'GetPlayerSummaries', 'v2', {
    key: apiKey,
    steamids: steamId,
    format: 'json',
  });
  const players = data?.response?.players ?? [];
  return players[0] ?? null;
}

// ---------------------------------------------------------------------------
// Artwork URLs — predictable CDN paths, no extra API call needed
// ---------------------------------------------------------------------------

function artworkUrls(appId) {
  const base = 'https://cdn.akamai.steamstatic.com/steam/apps';
  return {
    headerUrl: `${base}/${appId}/header.jpg`,          // 460×215
    capsuleUrl: `${base}/${appId}/capsule_231x87.jpg`,  // 231×87
    portraitUrl: `${base}/${appId}/library_600x900.jpg`, // 600×900 (poster-style)
  };
}

// ---------------------------------------------------------------------------
// Data processing
// ---------------------------------------------------------------------------

function buildSnapshot(games) {
  const snapshot = {};
  for (const g of games) {
    snapshot[g.appid] = g.playtime_forever ?? 0;
  }
  return snapshot;
}

function computeDeltas(prevSnapshot, currentSnapshot, gamesMap) {
  const deltas = [];
  for (const [appId, currentMinutes] of Object.entries(currentSnapshot)) {
    const prev = prevSnapshot[appId] ?? 0;
    const diff = currentMinutes - prev;
    if (diff > 0) {
      const game = gamesMap.get(Number(appId));
      deltas.push({
        name: game?.name ?? `Unknown (${appId})`,
        appId: Number(appId),
        minutesPlayed: diff,
      });
    }
  }
  // Sort by most played first
  deltas.sort((a, b) => b.minutesPlayed - a.minutesPlayed);
  return deltas;
}

function buildRecentlyPlayed(games, count) {
  // Filter to games played in the last 2 weeks (have playtime_2weeks) or
  // have a recent rtime_last_played, then sort by last played descending
  const played = games
    .filter((g) => g.rtime_last_played > 0)
    .sort((a, b) => b.rtime_last_played - a.rtime_last_played)
    .slice(0, count);

  return played.map((g) => ({
    name: g.name,
    appId: g.appid,
    ...artworkUrls(g.appid),
    playtimeForeverMinutes: g.playtime_forever ?? 0,
    playtime2WeeksMinutes: g.playtime_2weeks ?? 0,
    lastPlayed: new Date(g.rtime_last_played * 1000).toISOString(),
    playtimeByPlatform: {
      windows: g.playtime_windows_forever ?? 0,
      mac: g.playtime_mac_forever ?? 0,
      linux: g.playtime_linux_forever ?? 0,
      deck: g.playtime_deck_forever ?? 0,
    },
  }));
}

function buildStats(games) {
  const played = games.filter((g) => (g.playtime_forever ?? 0) > 0);
  const recentlyActive = games.filter((g) => (g.playtime_2weeks ?? 0) > 0);
  const totalMinutes = games.reduce((sum, g) => sum + (g.playtime_forever ?? 0), 0);

  return {
    totalGamesOwned: games.length,
    totalGamesPlayed: played.length,
    totalPlaytimeMinutes: totalMinutes,
    totalPlaytimeHours: Math.round((totalMinutes / 60) * 10) / 10,
    gamesPlayedLast2Weeks: recentlyActive.length,
    minutesLast2Weeks: recentlyActive.reduce((sum, g) => sum + (g.playtime_2weeks ?? 0), 0),
  };
}

// ---------------------------------------------------------------------------
// Daily log management
// ---------------------------------------------------------------------------

function updateDailyLog(existingLog, deltas, maxDays) {
  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  const totalMinutes = deltas.reduce((sum, d) => sum + d.minutesPlayed, 0);

  // Remove any existing entry for today (idempotent re-runs)
  const log = (existingLog ?? []).filter((entry) => entry.date !== today);

  // Only add an entry if there was actual playtime
  if (deltas.length > 0) {
    log.push({
      date: today,
      totalMinutes,
      games: deltas,
    });
  }

  // Sort descending by date and trim to maxDays
  log.sort((a, b) => b.date.localeCompare(a.date));
  return log.slice(0, maxDays);
}

// ---------------------------------------------------------------------------
// Input validation helpers
// ---------------------------------------------------------------------------

function positiveInt(raw, fallback, name) {
  const str = raw || String(fallback);
  if (!/^\d+$/.test(str)) throw new Error(`${name} must be a positive integer, got: ${raw}`);
  const n = Number(str);
  if (n < 1) throw new Error(`${name} must be a positive integer, got: ${raw}`);
  return n;
}

// ---------------------------------------------------------------------------
// Git helpers — no shell expansion, safe against injection
// ---------------------------------------------------------------------------

function gitSync(...args) {
  const r = spawnSync('git', args, { shell: false, stdio: 'pipe' });
  if (r.error) throw r.error;
  if (r.status !== 0) {
    const stderr = r.stderr?.toString().trim() || 'unknown error';
    throw new Error(`git ${args[0]} failed (exit ${r.status}): ${stderr}`);
  }
  return r;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function run() {
  try {
    const apiKey = core.getInput('steam_api_key', { required: true });
    const steamId = core.getInput('steam_id', { required: true });
    const outputPath = core.getInput('output_path') || 'src/data/gaming.json';
    const includeFree = core.getInput('include_free_games') !== 'false';
    const recentCount = positiveInt(core.getInput('recent_count'), 10, 'recent_count');
    const dailyLogDays = positiveInt(core.getInput('daily_log_days'), 90, 'daily_log_days');
    const skipCommit = core.getInput('skip_commit') === 'true';

    // Validate Steam ID — must be a 17-digit numeric string
    if (!/^\d{17}$/.test(steamId)) {
      throw new Error(`steam_id must be a 17-digit numeric Steam ID, got: ${steamId}`);
    }

    core.info('Fetching Steam data...');

    // Validate output path stays within the workspace
    const workspace = process.env.GITHUB_WORKSPACE ?? process.cwd();
    const absPath = path.resolve(workspace, outputPath);
    const relative = path.relative(workspace, absPath);
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
      throw new Error(`output_path must be inside the workspace (got: ${outputPath})`);
    }

    // Load existing data file (if any) for delta calculation
    let existing = {};
    if (fs.existsSync(absPath)) {
      try {
        existing = JSON.parse(fs.readFileSync(absPath, 'utf8'));
        core.info('Loaded existing data file for delta calculation');
      } catch (e) {
        core.warning(`Could not parse existing file: ${e.message}`);
      }
    }

    // Fetch from Steam API
    const [games, playerSummary] = await Promise.all([
      getOwnedGames(apiKey, steamId, includeFree),
      getPlayerSummary(apiKey, steamId),
    ]);

    core.info(`Fetched ${games.length} owned games`);

    // Build a lookup map
    const gamesMap = new Map(games.map((g) => [g.appid, g]));

    // Build current snapshot
    const currentSnapshot = buildSnapshot(games);
    const prevSnapshot = existing.snapshot?.games ?? {};

    // Compute daily deltas
    const deltas = computeDeltas(prevSnapshot, currentSnapshot, gamesMap);

    if (deltas.length > 0) {
      const totalMins = deltas.reduce((s, d) => s + d.minutesPlayed, 0);
      core.info(`Detected ${totalMins} minutes of playtime across ${deltas.length} games since last run`);
    } else {
      core.info('No new playtime detected since last run');
    }

    // Build output
    const output = {
      lastUpdated: new Date().toISOString(),
      profile: playerSummary
        ? {
            steamId,
            personaName: playerSummary.personaname,
            avatarUrl: playerSummary.avatarfull,
            profileUrl: playerSummary.profileurl,
          }
        : existing.profile ?? { steamId },
      recentlyPlayed: buildRecentlyPlayed(games, recentCount),
      stats: buildStats(games),
      dailyLog: updateDailyLog(existing.dailyLog, deltas, dailyLogDays),
      snapshot: {
        date: new Date().toISOString().slice(0, 10),
        games: currentSnapshot,
      },
    };

    // Write output
    const dir = path.dirname(absPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(absPath, JSON.stringify(output, null, 2) + '\n');
    core.info(`Wrote output to ${outputPath}`);

    // Git commit (unless skipped)
    const changesDetected = deltas.length > 0 ||
      !existing.lastUpdated ||
      JSON.stringify(existing.stats) !== JSON.stringify(output.stats);

    core.setOutput('changes_detected', changesDetected.toString());

    if (!skipCommit && changesDetected) {
      try {
        gitSync('config', 'user.name', 'github-actions[bot]');
        gitSync('config', 'user.email', 'github-actions[bot]@users.noreply.github.com');
        gitSync('add', absPath);
        // Note: not using gitSync here — git diff --staged --quiet intentionally exits non-zero
        // when there ARE staged changes, so gitSync would throw. Inspect status directly instead.
        const diffResult = spawnSync('git', ['diff', '--staged', '--quiet'], { shell: false });
        if (diffResult.error) throw diffResult.error;
        const hasStaged = diffResult.status !== 0;
        if (hasStaged) {
          gitSync('commit', '-m', 'chore: update steam gaming data');
          core.info('Committed changes');
        }
      } catch (e) {
        core.warning(`Git commit failed: ${e.message}`);
      }
    }
  } catch (error) {
    core.setFailed(error.message);
  }
}

run();
