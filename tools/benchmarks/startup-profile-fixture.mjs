/**
 * Synthetic userData profile for the startup benchmarks.
 *
 * Builds a tree shaped like a long-lived real profile (tens of thousands of
 * Chromium cache files — the documented pathological case for the win32 startup
 * ACL grant), optional restored-session state, optional GitHub repos that reach
 * the `gh` login probe, and the isolated environment the app is launched under.
 */
import { spawnSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import os from 'node:os'
import { delimiter, join, resolve } from 'node:path'

export const STATE_PROFILES = ['none', 'restored-local-tabs']

/** Both benchmarks must land on the same fixture for the same shape. */
export function resolveFixtureDir({ fixtureDir, files, stateProfile, sessionTabs, githubRepos }) {
  return resolve(
    fixtureDir ??
      join(
        os.tmpdir(),
        'orca-startup-bench',
        `userdata-${files}-${stateProfile}-${sessionTabs}-gh${githubRepos}`
      )
  )
}

/**
 * The file count drives the win32 icacls walk cost; contents are irrelevant, so
 * files are tiny. Layout mirrors Chromium cache dirs plus a few Orca-owned dirs.
 */
export function ensureFixture(fixtureDir, options) {
  const { fileCount, stateProfile, sessionTabs, githubRepos } = options
  const manifestPath = join(fixtureDir, 'bench-fixture-manifest.json')
  if (existsSync(manifestPath)) {
    try {
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'))
      if (
        manifest.files === fileCount &&
        manifest.stateProfile === stateProfile &&
        manifest.sessionTabs === sessionTabs &&
        (manifest.githubRepos ?? 0) === githubRepos
      ) {
        console.log(`[fixture] reusing ${fixtureDir} (${fileCount} files, state=${stateProfile})`)
        return
      }
    } catch {
      // fall through and rebuild
    }
  }
  console.log(`[fixture] creating ${fixtureDir} with ~${fileCount} synthetic files…`)
  const buckets = [
    ['Cache', 'Cache_Data'],
    ['Code Cache', 'js'],
    ['Code Cache', 'wasm'],
    ['GPUCache'],
    ['DawnGraphiteCache'],
    ['blob_storage', 'blobs'],
    ['Service Worker', 'CacheStorage'],
    ['terminal-scrollback-snapshots']
  ]
  // Why: a rebuild writes fileCount files but does not remove the ones already
  // there, so shrinking the count would leave the surplus on disk and the new
  // manifest would claim a smaller fixture than exists — misreporting the one
  // quantity this fixture models. The default fixture path encodes the shape,
  // so only an explicit --fixture-dir reaches a rebuild in the same directory.
  // Scoped to the buckets this function owns: --fixture-dir may point anywhere.
  for (const bucket of buckets) {
    rmSync(join(fixtureDir, bucket[0]), { recursive: true, force: true })
  }
  const payload = 'x'.repeat(1024)
  let written = 0
  const started = Date.now()
  for (let b = 0; written < fileCount; b = (b + 1) % buckets.length) {
    const dir = join(fixtureDir, ...buckets[b], `g${Math.floor(written / 512)}`)
    mkdirSync(dir, { recursive: true })
    const batch = Math.min(512, fileCount - written)
    for (let i = 0; i < batch; i++) {
      writeFileSync(join(dir, `f_${String(written + i).padStart(6, '0')}`), payload)
    }
    written += batch
  }
  const persistedStateBytes = writePersistedStateFixture(fixtureDir, {
    stateProfile,
    sessionTabs,
    githubRepos
  })
  writeFileSync(
    manifestPath,
    JSON.stringify({
      files: fileCount,
      stateProfile,
      sessionTabs,
      githubRepos,
      persistedStateBytes,
      createdAt: Date.now()
    })
  )
  console.log(`[fixture] done in ${((Date.now() - started) / 1000).toFixed(1)}s`)
}

function initFixtureGitRepo(repoDir) {
  mkdirSync(repoDir, { recursive: true })
  if (!existsSync(join(repoDir, '.git'))) {
    const init = spawnSync('git', ['init', repoDir], { stdio: 'ignore' })
    if (init.status !== 0) {
      throw new Error(`Failed to create git repo fixture at ${repoDir}`)
    }
  }
  return realpathSync(repoDir)
}

/**
 * Seed repos whose hydration reaches the `gh` login probe: a GitHub `origin`
 * remote and no github.user/user.username config (the bench also points
 * GIT_CONFIG_GLOBAL away from the developer's real config at launch).
 */
function buildGithubRepoFixtures(fixtureDir, githubRepos) {
  const repos = []
  for (let i = 0; i < githubRepos; i++) {
    const repoPath = initFixtureGitRepo(join(fixtureDir, `bench-gh-repo-${i}`))
    const remote = spawnSync(
      'git',
      [
        '-C',
        repoPath,
        'remote',
        'add',
        'origin',
        `https://github.com/orca-bench/bench-gh-repo-${i}.git`
      ],
      { stdio: 'ignore' }
    )
    // Exit 3 (remote exists) is fine on fixture reuse; anything else is not.
    if (remote.status !== 0 && remote.status !== 3) {
      throw new Error(`Failed to add GitHub remote to ${repoPath}`)
    }
    repos.push({
      id: `bench-gh-repo-${i}`,
      path: repoPath,
      displayName: `Bench GH Repo ${i}`,
      badgeColor: '#000000',
      addedAt: 1,
      externalWorktreeVisibility: 'show'
    })
  }
  return repos
}

function writePersistedStateFixture(fixtureDir, { stateProfile, sessionTabs, githubRepos }) {
  const dataPath = join(fixtureDir, 'orca-data.json')
  if (stateProfile === 'none' && githubRepos === 0) {
    try {
      unlinkSync(dataPath)
    } catch {
      // no persisted state fixture
    }
    return 0
  }
  if (!STATE_PROFILES.includes(stateProfile)) {
    throw new Error(`Unknown state profile: ${stateProfile}`)
  }

  const githubRepoEntries = buildGithubRepoFixtures(fixtureDir, githubRepos)
  if (stateProfile === 'none') {
    const state = {
      schemaVersion: 1,
      repos: githubRepoEntries,
      settings: {
        telemetry: {
          installId: 'startup-bench',
          optedIn: false,
          existedBeforeTelemetryRelease: true
        }
      }
    }
    const json = JSON.stringify(state, null, 2)
    writeFileSync(dataPath, json, 'utf-8')
    return Buffer.byteLength(json)
  }

  const repoPath = initFixtureGitRepo(join(fixtureDir, 'bench-repo'))
  const repoId = 'bench-repo'
  const worktreeId = `${repoId}::${repoPath}`
  const tabCount = Math.max(1, sessionTabs)
  const tabs = []
  const terminalLayoutsByTabId = {}
  const activeTabIdByWorktree = {}
  for (let i = 0; i < tabCount; i++) {
    const tabId = `bench-tab-${String(i).padStart(5, '0')}`
    const ptyId = `bench-pty-${String(i).padStart(5, '0')}`
    tabs.push({
      id: tabId,
      ptyId,
      worktreeId,
      title: `Terminal ${i + 1}`,
      customTitle: null,
      color: null,
      sortOrder: i,
      createdAt: 1
    })
    terminalLayoutsByTabId[tabId] = {
      root: null,
      activeLeafId: null,
      expandedLeafId: null
    }
  }
  activeTabIdByWorktree[worktreeId] = tabs[0]?.id ?? null
  const state = {
    schemaVersion: 1,
    repos: [
      {
        id: repoId,
        path: repoPath,
        displayName: 'Bench Repo',
        badgeColor: '#000000',
        addedAt: 1,
        externalWorktreeVisibility: 'show'
      },
      ...githubRepoEntries
    ],
    settings: {
      telemetry: {
        installId: 'startup-bench',
        optedIn: false,
        existedBeforeTelemetryRelease: true
      }
    },
    ui: {
      lastActiveRepoId: repoId,
      lastActiveWorktreeId: worktreeId
    },
    workspaceSession: {
      activeRepoId: repoId,
      activeWorktreeId: worktreeId,
      activeTabId: tabs[0]?.id ?? null,
      tabsByWorktree: {
        [worktreeId]: tabs
      },
      terminalLayoutsByTabId,
      activeTabIdByWorktree,
      activeWorktreeIdsOnShutdown: [worktreeId],
      defaultTerminalTabsAppliedByWorktreeId: {
        [worktreeId]: true
      }
    }
  }
  const json = JSON.stringify(state, null, 2)
  writeFileSync(dataPath, json, 'utf-8')
  return Buffer.byteLength(json)
}

/**
 * Fake `gh` that hangs like a blackholed api.github.com. The hang lives in a
 * child process (ping/sleep) that inherits the probe's stdio pipes, so even
 * after a probe timeout kills the shim itself, the child keeps the pipe open —
 * reproducing the mechanism that lets a hung real gh outlive execSync's
 * timeout on the Electron main thread.
 */
export function writeGhShim(fixtureDir, ghHangMs) {
  if (!ghHangMs) {
    return null
  }
  const shimDir = join(fixtureDir, 'gh-shim')
  mkdirSync(shimDir, { recursive: true })
  const hangSeconds = Math.max(1, Math.ceil(ghHangMs / 1000))
  if (process.platform === 'win32') {
    // ping -n K waits K-1 seconds between K probes of localhost.
    writeFileSync(
      join(shimDir, 'gh.cmd'),
      `@echo off\r\nping -n ${hangSeconds + 1} 127.0.0.1\r\nexit /b 1\r\n`
    )
  } else {
    const shimPath = join(shimDir, 'gh')
    writeFileSync(shimPath, `#!/bin/sh\nsleep ${hangSeconds}\nexit 1\n`)
    spawnSync('chmod', ['+x', shimPath], { stdio: 'ignore' })
  }
  return shimDir
}

export function buildLaunchEnvironment({ fixtureDir, githubRepos, ghShimDir }) {
  // Why: keep Codex home work inside the benchmark fixture and keep the
  // default-ON rollout from adding unrelated migration work to timings.
  const isolatedHome = join(fixtureDir, 'home')
  mkdirSync(isolatedHome, { recursive: true })
  const env = {
    ...process.env,
    ORCA_STARTUP_DIAGNOSTICS: '1',
    ORCA_E2E_USER_DATA_DIR: fixtureDir,
    HOME: isolatedHome,
    USERPROFILE: isolatedHome,
    ORCA_E2E_HOME_DIR: isolatedHome,
    ORCA_CODEX_SYSTEM_DEFAULT_REAL_HOME: '0',
    ORCA_E2E_HEADLESS: '1'
  }
  delete env.CODEX_HOME
  delete env.ORCA_CODEX_HOME
  if (ghShimDir) {
    env.PATH = `${ghShimDir}${delimiter}${env.PATH ?? ''}`
  }
  if (githubRepos > 0) {
    // Keep the developer's real github.user/user.username out of the run so
    // repo hydration deterministically falls through to the gh probe.
    const emptyGitConfig = join(fixtureDir, 'bench-empty-gitconfig')
    if (!existsSync(emptyGitConfig)) {
      writeFileSync(emptyGitConfig, '')
    }
    env.GIT_CONFIG_GLOBAL = emptyGitConfig
    env.GIT_CONFIG_NOSYSTEM = '1'
  }
  return env
}

/** Fixture + gh shim + environment in one step, shared by both benchmark CLIs. */
export function prepareStartupFixture(args) {
  const fixtureDir = resolveFixtureDir(args)
  mkdirSync(fixtureDir, { recursive: true })
  ensureFixture(fixtureDir, {
    fileCount: args.files,
    stateProfile: args.stateProfile,
    sessionTabs: args.sessionTabs,
    githubRepos: args.githubRepos
  })
  const ghShimDir = writeGhShim(fixtureDir, args.ghHangMs)
  const launchEnv = buildLaunchEnvironment({
    fixtureDir,
    githubRepos: args.githubRepos,
    ghShimDir
  })
  return { fixtureDir, launchEnv }
}
