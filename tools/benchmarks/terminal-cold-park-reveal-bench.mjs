#!/usr/bin/env node
// Cold-park reveal-cost benchmark: measures the reveal latency a user pays when
// returning to a terminal whose hidden view was cold-parked (React subtree
// unmounted, xterm/buffers/WebGL released) versus a warm reveal where the tab
// was still in the hot-retain working set. The stock terminal-perf-bench
// workspace-switch scenario cycles 3 worktrees fast enough that parking never
// fires, so it only ever measures warm reveals. This bench drives the
// ORCA_E2E_TERMINAL_PARKING_DELAY_MS override to shrink the 30s hysteresis and
// window.__terminalParkingDebug.parkedTabIds() to *confirm* a tab parked before
// timing its reveal — so the cold vs warm delta is the real cost of parking.
//
// Output phases per reveal (ms from the switch-back click):
//   activationMs   store activeWorktree flips to the target terminal
//   ptyBindMs      the revealed pane has a bound ptyId (xterm remounted+attached)
//   paintSettleMs  two RAFs after ptyBind (first painted frame settled)
//
// Arms:
//   cold  — tab confirmed parked before reveal (park delay shrunk, wait to park)
//   warm  — tab revealed before the park delay elapses (hot-retain hit)
//   off   — parking disabled entirely (kill switch), reveal after the same idle

import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import {
  collectRendererDiagnostics,
  connectToApp,
  installRendererProbe,
  launchDevApp,
  pickFreePort,
  stopDevApp,
  waitForStoreReady
} from '../../config/scripts/windows-apphang-repro/electron-dev-session.mjs'
import { createCompletedOnboardingProfile } from '../../config/scripts/windows-apphang-repro/wsl-workspace-fixture.mjs'
import {
  pollUntil,
  rendererActionTimeoutMs,
  runWithTimeout,
  setupTimeoutMs
} from '../../config/scripts/windows-apphang-repro/repro-timing.mjs'
import { safeRemoveLocalDirectory } from '../../config/scripts/windows-apphang-repro/wsl-workspace-fixture.mjs'

const rootDir = path.resolve(fileURLToPath(new URL('../..', import.meta.url)))
const scenarioTimeoutMs = 300_000

// Short enough that a tab parks within a few seconds of being hidden, long
// enough that the warm arm can reliably reveal before it elapses.
const PARK_DELAY_MS = 1_500
const WARM_REVEAL_AFTER_MS = 300
const COLD_PARK_CONFIRM_TIMEOUT_MS = 15_000

function parseArgs() {
  const args = { label: 'run', cycles: 8, scrollbackLines: 0, reportPath: null, keep: false }
  for (const arg of process.argv.slice(2)) {
    if (arg === '--help' || arg === '-h') {
      console.log(
        'Usage: node tools/benchmarks/terminal-cold-park-reveal-bench.mjs [--label=name] [--cycles=N] [--scrollback-lines=N] [--report=path] [--keep]'
      )
      process.exit(0)
    }
    if (arg === '--keep') {
      args.keep = true
      continue
    }
    const [name, value] = arg.split('=', 2)
    if (name === '--label') {
      args.label = value?.trim() || 'run'
    } else if (name === '--cycles') {
      args.cycles = Math.max(1, Number(value) || 8)
    } else if (name === '--scrollback-lines') {
      args.scrollbackLines = Math.max(0, Number(value) || 0)
    } else if (name === '--report') {
      args.reportPath = value
    }
  }
  return args
}

// Why: the daemon binds a Unix socket at <userData>/daemon/daemon-v20.sock.
// macOS sun_path caps at ~104 chars; the default os.tmpdir() (/var/folders/…)
// blows past it, the daemon fails EINVAL, terminals fall back to non-snapshot
// PTYs, and cold parking (snapshot-backed only) can never engage. Root the
// userData + fixture under a short ~/.ocpb path so the socket fits.
const shortRoot = path.join(os.homedir(), '.ocpb')

function createShortUserDataDirectory() {
  mkdirSync(shortRoot, { recursive: true })
  const userDataDir = mkdtempSync(path.join(shortRoot, 'ud-'))
  createCompletedOnboardingProfile(userDataDir)
  return userDataDir
}

function git(cwd, ...cmd) {
  execFileSync('git', cmd, { cwd, stdio: 'pipe' })
}

function createLocalRepoFixture() {
  mkdirSync(shortRoot, { recursive: true })
  const baseDir = mkdtempSync(path.join(shortRoot, 'fx-'))
  const repoPath = path.join(baseDir, 'repo')
  mkdirSync(repoPath, { recursive: true })
  git(repoPath, 'init', '--initial-branch=main')
  git(repoPath, 'config', 'user.email', 'bench@orca.local')
  git(repoPath, 'config', 'user.name', 'Orca Bench')
  writeFileSync(path.join(repoPath, 'README.md'), '# cold-park fixture\n')
  git(repoPath, 'add', '.')
  git(repoPath, 'commit', '-m', 'init', '--no-gpg-sign')
  const worktreePaths = []
  for (const name of ['wt-one', 'wt-two']) {
    const worktreePath = path.join(baseDir, name)
    git(repoPath, 'worktree', 'add', worktreePath, '-b', name)
    worktreePaths.push(worktreePath)
  }
  return { baseDir, repoPath, worktreePaths }
}

async function setupWorkspaces(page, fixture) {
  return await runWithTimeout(
    'fixture registration in Orca',
    () =>
      page.evaluate(
        async ({ repoPath, importedWorktreePaths }) => {
          const store = window.__store
          if (!store) {
            throw new Error('window.__store is unavailable.')
          }
          await store.getState().fetchSettings?.()
          const addResult = await window.api.repos.add({ path: repoPath, kind: 'git' })
          if ('error' in addResult) {
            throw new Error(addResult.error)
          }
          await store.getState().fetchRepos()
          const state = store.getState()
          const repo = state.repos.find((c) => c.path === repoPath) ?? addResult.repo
          await state.updateRepo(repo.id, {
            externalWorktreeVisibility: 'show',
            externalWorktreeVisibilityPromptDismissedAt: Date.now(),
            importedExternalWorktreePaths: importedWorktreePaths,
            externalWorktreeInboxBaselinePaths: importedWorktreePaths
          })
          await store.getState().fetchWorktrees(repo.id, { requireAuthoritative: true })
          const nextState = store.getState()
          nextState.setSidebarOpen(true)
          nextState.setGroupBy('none')
          nextState.setSortBy('recent')
          nextState.setShowActiveOnly(false)
          nextState.setActiveView('terminal')
          const worktrees = nextState.worktreesByRepo[repo.id] ?? []
          return {
            repoId: repo.id,
            worktrees: worktrees.map((w) => ({
              id: w.id,
              path: w.path,
              displayName: w.displayName,
              isMainWorktree: w.isMainWorktree
            }))
          }
        },
        { repoPath: fixture.repoPath, importedWorktreePaths: fixture.worktreePaths }
      ),
    setupTimeoutMs
  )
}

async function clickWorktreeCard(page, worktreeId) {
  const rect = await runWithTimeout(
    `locate worktree card ${worktreeId}`,
    () =>
      page.evaluate((id) => {
        const rows = Array.from(document.querySelectorAll('[data-worktree-id]'))
        const row = rows.find((c) => c.getAttribute('data-worktree-id') === id)
        if (!row) {
          return null
        }
        row.scrollIntoView({ block: 'center', inline: 'nearest' })
        const surface = row.querySelector('[data-worktree-card-surface="true"]') ?? row
        const bounds = surface.getBoundingClientRect()
        if (bounds.width <= 0 || bounds.height <= 0) {
          return null
        }
        return { x: bounds.left + bounds.width / 2, y: bounds.top + bounds.height / 2 }
      }, worktreeId),
    rendererActionTimeoutMs
  )
  if (!rect) {
    throw new Error(`Could not find rendered worktree card for ${worktreeId}`)
  }
  await runWithTimeout(
    `click worktree card ${worktreeId}`,
    () => page.mouse.click(rect.x, rect.y),
    rendererActionTimeoutMs
  )
}

async function activateWorktreeTerminal(page, worktreeId) {
  await clickWorktreeCard(page, worktreeId)
  await pollUntil(
    `active worktree ${worktreeId}`,
    () =>
      page.evaluate((id) => {
        const state = window.__store?.getState?.()
        return state?.activeWorktreeId === id && state.activeTabType === 'terminal'
      }, worktreeId),
    Boolean,
    30_000
  )
}

/** Wait until the active terminal pane of `worktreeId` has a bound ptyId — i.e.
 *  its terminal actually exists and is warm before we start hiding it. */
async function waitForBoundTerminal(page, worktreeId) {
  return await pollUntil(
    `pty bound ${worktreeId}`,
    () =>
      page.evaluate((id) => {
        const state = window.__store?.getState?.()
        const tabId =
          state?.activeWorktreeId === id && state.activeTabType === 'terminal'
            ? state.activeTabId
            : (state?.activeTabIdByWorktree?.[id] ?? null)
        const manager = tabId ? window.__paneManagers?.get(tabId) : null
        const pane = manager?.getActivePane?.() ?? manager?.getPanes?.()?.[0] ?? null
        return pane?.container?.dataset?.ptyId ?? null
      }, worktreeId),
    Boolean,
    30_000,
    10
  )
}

/** Fill the active pane's terminal with ~lineCount lines of output so the
 *  parked snapshot (and thus the cold reveal replay) reflects a busy TUI-sized
 *  buffer rather than an empty shell. Writes to the pty and waits for the
 *  xterm buffer to grow. Returns the observed serialized length. */
async function primeScrollback(page, worktreeId, lineCount) {
  const ptyId = await page.evaluate((id) => {
    const state = window.__store?.getState?.()
    const tabId =
      state?.activeWorktreeId === id && state.activeTabType === 'terminal'
        ? state.activeTabId
        : (state?.activeTabIdByWorktree?.[id] ?? null)
    const manager = tabId ? window.__paneManagers?.get(tabId) : null
    const pane = manager?.getActivePane?.() ?? manager?.getPanes?.()?.[0] ?? null
    return pane?.container?.dataset?.ptyId ?? null
  }, worktreeId)
  if (!ptyId) {
    throw new Error(`No pty to prime for ${worktreeId}`)
  }
  // A single command that emits many numbered 80-col lines. seq is POSIX-ish;
  // fall back handled by awk for portability.
  const cmd = `awk 'BEGIN{for(i=0;i<${lineCount};i++)printf "%04d %s\\n", i, "cold-park-scrollback-priming-line-padding-to-eighty-cols-000000"}'\n`
  await page.evaluate(({ id, c }) => window.api.pty.write(id, c), { id: ptyId, c: cmd })
  return await pollUntil(
    `scrollback primed ${worktreeId}`,
    () =>
      page.evaluate((id) => {
        const state = window.__store?.getState?.()
        const tabId =
          state?.activeWorktreeId === id && state.activeTabType === 'terminal'
            ? state.activeTabId
            : (state?.activeTabIdByWorktree?.[id] ?? null)
        const manager = tabId ? window.__paneManagers?.get(tabId) : null
        const pane = manager?.getActivePane?.() ?? manager?.getPanes?.()?.[0] ?? null
        const content = pane?.serializeAddon?.serialize?.() ?? ''
        return content.length
      }, worktreeId),
    (len) => Number.isFinite(len) && len > lineCount * 40,
    20_000,
    100
  ).catch(() => 0)
}

function activeTabIdFor(page, worktreeId) {
  return page.evaluate((id) => {
    const state = window.__store?.getState?.()
    return (
      (state?.activeWorktreeId === id && state.activeTabType === 'terminal'
        ? state.activeTabId
        : (state?.activeTabIdByWorktree?.[id] ?? null)) ?? null
    )
  }, worktreeId)
}

/** Times a reveal of `targetId` (must currently be hidden). Returns the three
 *  phase timings measured from the switch-back click. */
async function timeReveal(page, targetId) {
  const t0 = Date.now()
  await clickWorktreeCard(page, targetId)
  await pollUntil(
    `reveal activation ${targetId}`,
    () =>
      page.evaluate((id) => {
        const state = window.__store?.getState?.()
        return state?.activeWorktreeId === id && state.activeTabType === 'terminal'
      }, targetId),
    Boolean,
    30_000,
    5
  )
  const activationMs = Date.now() - t0
  await pollUntil(
    `reveal pty ${targetId}`,
    () =>
      page.evaluate((id) => {
        const state = window.__store?.getState?.()
        const tabId =
          state?.activeWorktreeId === id && state.activeTabType === 'terminal'
            ? state.activeTabId
            : (state?.activeTabIdByWorktree?.[id] ?? null)
        const manager = tabId ? window.__paneManagers?.get(tabId) : null
        const pane = manager?.getActivePane?.() ?? manager?.getPanes?.()?.[0] ?? null
        return pane?.container?.isConnected ? (pane?.container?.dataset?.ptyId ?? null) : null
      }, targetId),
    Boolean,
    30_000,
    5
  )
  const ptyBindMs = Date.now() - t0
  await runWithTimeout(
    'reveal paint settle',
    () =>
      page.evaluate(
        () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))
      ),
    rendererActionTimeoutMs
  )
  const paintSettleMs = Date.now() - t0
  return { activationMs, ptyBindMs, paintSettleMs }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** Parking signal that does not depend on the e2e debug handle: a parked tab's
 *  TerminalPane unmounts, so its manager leaves window.__paneManagers AND the
 *  overlay slot renders null (no [data-tab-id] container). Prefer the debug
 *  handle when present, fall back to manager/DOM absence. */
function isTabParked(page, tabId) {
  return page.evaluate((id) => {
    const handleIds = window.__terminalParkingDebug?.parkedTabIds?.()
    if (Array.isArray(handleIds)) {
      return { source: 'handle', parked: handleIds.includes(id) }
    }
    // Fallback (no debug handle): a parked tab's manager leaves __paneManagers.
    const managerGone = !(window.__paneManagers && window.__paneManagers.has(id))
    return { source: 'manager', parked: managerGone }
  }, tabId)
}

async function debugSnapshot(page, tabId, worktreeId) {
  return page.evaluate(
    ({ id, wtId }) => {
      const state = window.__store?.getState?.()
      const tabsByWorktree = state?.tabsByWorktree ?? {}
      const tab = Object.values(tabsByWorktree)
        .flat()
        .find((t) => t?.id === id)
      const wtTabs = tabsByWorktree[wtId] ?? []
      return {
        handlePresent: typeof window.__terminalParkingDebug?.parkedTabIds === 'function',
        parkDelayMs: window.__terminalParkingDebug?.parkDelayMs ?? null,
        parkedHandleIds: window.__terminalParkingDebug?.parkedTabIds?.() ?? null,
        managerPresent: Boolean(window.__paneManagers?.has(id)),
        managerKeys: window.__paneManagers ? Array.from(window.__paneManagers.keys()) : null,
        ptyId: tab?.ptyId ?? null,
        worktreeTabCount: wtTabs.length,
        worktreeTabPtyIds: wtTabs.map((t) => t?.ptyId ?? null),
        activeTabIdByWorktree: state?.activeTabIdByWorktree?.[wtId] ?? null,
        parkingEnabled: state?.settings?.terminalHiddenViewParking !== false
      }
    },
    { id: tabId, wtId: worktreeId }
  )
}

/** One cold cycle: focus target, hide it (switch to primary), wait until the
 *  tab parks (debug handle or manager-absence), then time the reveal. */
async function runColdCycle(page, primaryId, targetId, wantDebug, scrollbackLines) {
  await activateWorktreeTerminal(page, targetId)
  await waitForBoundTerminal(page, targetId)
  if (scrollbackLines > 0) {
    await primeScrollback(page, targetId, scrollbackLines)
  }
  const targetTabId = await activeTabIdFor(page, targetId)
  await activateWorktreeTerminal(page, primaryId)
  const parked = await pollUntil(
    `cold-park ${targetTabId}`,
    () => isTabParked(page, targetTabId),
    (result) => result?.parked === true,
    COLD_PARK_CONFIRM_TIMEOUT_MS,
    50
  ).then(
    () => true,
    () => false
  )
  const diag = wantDebug ? await debugSnapshot(page, targetTabId, targetId) : null
  const timings = await timeReveal(page, targetId)
  return { ...timings, parkedConfirmed: parked, diag }
}

/** One warm cycle: focus target, hide it briefly (under the park delay), reveal
 *  before it can park. Asserts it did NOT park. */
async function runWarmCycle(page, primaryId, targetId, scrollbackLines) {
  await activateWorktreeTerminal(page, targetId)
  await waitForBoundTerminal(page, targetId)
  if (scrollbackLines > 0) {
    await primeScrollback(page, targetId, scrollbackLines)
  }
  const targetTabId = await activeTabIdFor(page, targetId)
  await activateWorktreeTerminal(page, primaryId)
  await sleep(WARM_REVEAL_AFTER_MS)
  const parked = await isTabParked(page, targetTabId)
  const timings = await timeReveal(page, targetId)
  return { ...timings, parkedConfirmed: parked?.parked === true }
}

function summarize(values) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b)
  if (!sorted.length) {
    return null
  }
  const at = (f) => sorted[Math.min(sorted.length - 1, Math.round(f * (sorted.length - 1)))]
  return {
    count: sorted.length,
    median: Math.round(at(0.5)),
    p95: Math.round(at(0.95)),
    max: sorted.at(-1)
  }
}

function summarizeArm(name, samples) {
  const fields = {}
  for (const key of ['activationMs', 'ptyBindMs', 'paintSettleMs']) {
    fields[key] = summarize(samples.map((s) => s[key]))
  }
  return {
    name,
    samples: samples.length,
    parkedConfirmed: samples.filter((s) => s.parkedConfirmed).length,
    fields
  }
}

async function main() {
  const args = parseArgs()
  const startedAt = Date.now()
  const report = {
    label: args.label,
    startedAt: new Date(startedAt).toISOString(),
    platform: `${process.platform} ${os.release()}`,
    parkDelayMs: PARK_DELAY_MS,
    args: { cycles: args.cycles, scrollbackLines: args.scrollbackLines },
    arms: {},
    summaries: [],
    cleanupErrors: []
  }
  let fixture = null
  let userDataDir = null
  let launched = null
  let browser = null
  let page = null
  try {
    fixture = createLocalRepoFixture()
    const cdpPort = await pickFreePort()
    userDataDir = createShortUserDataDirectory()
    // Shrink the 30s cold-park hysteresis + 5-min hot-retain so parking is
    // observable in a benchmark run. Inherited by launchDevApp into the app.
    process.env.ORCA_E2E_TERMINAL_PARKING_DELAY_MS = String(PARK_DELAY_MS)
    console.log(
      `[cold-park] fixture=${fixture.baseDir} userData=${userDataDir} cdp=${cdpPort} parkDelay=${PARK_DELAY_MS}ms`
    )
    launched = launchDevApp({ cdpPort, userDataDir })
    const connected = await connectToApp(cdpPort)
    browser = connected.browser
    page = connected.page
    await waitForStoreReady(page)
    await installRendererProbe(page)
    const setup = await setupWorkspaces(page, fixture)
    let worktrees = setup.worktrees
    // Why: worktree registration/fetch can lag the setup evaluate return; poll
    // the store until the two external worktrees materialize before asserting.
    if (worktrees.length < 2) {
      // Why: the initial fetchWorktrees can return before the external-worktree
      // scan surfaces the imported paths. Re-drive the fetch each poll (not just
      // re-read the store) so a missed first scan self-heals.
      worktrees = await pollUntil(
        'worktrees registered',
        () =>
          page.evaluate(async (repoId) => {
            await window.__store
              ?.getState?.()
              ?.fetchWorktrees?.(repoId, { requireAuthoritative: true })
              .catch(() => undefined)
            const state = window.__store?.getState?.()
            const list = state?.worktreesByRepo?.[repoId] ?? []
            return list.map((w) => ({
              id: w.id,
              path: w.path,
              displayName: w.displayName,
              isMainWorktree: w.isMainWorktree
            }))
          }, setup.repoId),
        (list) => Array.isArray(list) && list.length >= 2,
        30_000,
        500
      )
    }
    if (worktrees.length < 2) {
      throw new Error(`Expected >=2 worktrees, got ${worktrees.length}`)
    }
    const primary = worktrees.find((w) => w.isMainWorktree) ?? worktrees[0]
    const target = worktrees.find((w) => w.id !== primary.id)
    await activateWorktreeTerminal(page, primary.id)
    await waitForBoundTerminal(page, primary.id)

    // Confirm the parking debug handle is present (exposeStore gate). It
    // registers on first pane mount, so poll rather than read once.
    const debugReady = await pollUntil(
      'parking debug handle',
      () => page.evaluate(() => typeof window.__terminalParkingDebug?.parkedTabIds === 'function'),
      Boolean,
      10_000,
      100
    ).then(
      () => true,
      () => false
    )
    report.parkingDebugHandlePresent = debugReady

    const cold = []
    const warm = []
    console.log(`[cold-park] running ${args.cycles} cold + ${args.cycles} warm cycles`)
    for (let i = 0; i < args.cycles; i++) {
      warm.push(
        await runWithTimeout(
          `warm cycle ${i}`,
          () => runWarmCycle(page, primary.id, target.id, args.scrollbackLines),
          scenarioTimeoutMs
        )
      )
      const coldResult = await runWithTimeout(
        `cold cycle ${i}`,
        () => runColdCycle(page, primary.id, target.id, i === 0, args.scrollbackLines),
        scenarioTimeoutMs
      )
      if (i === 0 && coldResult.diag) {
        report.firstColdDiag = coldResult.diag
        console.log(`[cold-park] first-cold diag: ${JSON.stringify(coldResult.diag)}`)
      }
      cold.push(coldResult)
    }
    report.arms.cold = cold
    report.arms.warm = warm
    report.summaries.push(summarizeArm('cold', cold))
    report.summaries.push(summarizeArm('warm', warm))
    report.finalDiagnostics = await collectRendererDiagnostics(page)
  } finally {
    report.elapsedMs = Date.now() - startedAt
    if (browser) {
      await browser.close().catch(() => undefined)
    }
    if (launched) {
      try {
        await stopDevApp(launched.child)
      } catch (error) {
        report.cleanupErrors.push(error instanceof Error ? error.message : String(error))
      }
      report.appLogsTail = launched.logs.slice(-60)
    }
    if (!args.keep) {
      if (fixture) {
        safeRemoveLocalDirectory(fixture.baseDir, report.cleanupErrors)
      }
      if (userDataDir) {
        safeRemoveLocalDirectory(userDataDir, report.cleanupErrors)
      }
    }
    const stamp = new Date(startedAt).toISOString().replace(/[:.]/g, '-')
    const reportPath = path.resolve(
      args.reportPath ??
        path.join(
          rootDir,
          'tools',
          'benchmarks',
          'results',
          `cold-park-${args.label}-${stamp}.json`
        )
    )
    mkdirSync(path.dirname(reportPath), { recursive: true })
    writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`)
    console.log(`[cold-park] report=${reportPath}`)
    const coldArm = report.summaries.find((s) => s.name === 'cold')
    if (coldArm && coldArm.parkedConfirmed < coldArm.samples) {
      console.log(
        `[cold-park] WARNING: only ${coldArm.parkedConfirmed}/${coldArm.samples} cold reveals were confirmed parked — treat unconfirmed samples with caution`
      )
    }
    for (const summary of report.summaries) {
      console.log(
        `[cold-park] ${summary.name}: samples=${summary.samples} parkedConfirmed=${summary.parkedConfirmed}/${summary.samples}`
      )
      for (const [field, stats] of Object.entries(summary.fields)) {
        if (stats) {
          console.log(
            `[cold-park]   ${field}: median=${stats.median}ms p95=${stats.p95}ms max=${stats.max}ms`
          )
        }
      }
    }
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error))
  process.exit(1)
})
