#!/usr/bin/env node
// Cold-park RESOURCE-BENEFIT benchmark: answers "is cold parking worth having?"
// by measuring what it actually saves at many-worktree scale — renderer JS
// heap, live WebGL contexts, and mounted pane managers — with parking OFF vs
// ON in the SAME app session (toggled via the terminalHiddenViewParking
// setting). The companion reveal-cost bench measures the price you pay on
// reveal; this measures the benefit you get while backgrounded.
//
// Method: create N worktrees each with one terminal primed with scrollback,
// leave one foreground and background the rest, then read resources in two
// states:
//   off — parking disabled: every hidden terminal stays fully mounted
//   on  — parking enabled: hidden terminals past the (shrunk) hysteresis park
// The off−on delta is the resource win parking buys.

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
const PARK_DELAY_MS = 1_500
const SETTLE_AFTER_PARK_MS = 4_000
// Short root so the daemon Unix socket fits under the macOS 104-char limit;
// the default /var/folders tmp path overruns it and the daemon fails, leaving
// terminals non-snapshot-backed and therefore unparkable.
const shortRoot = path.join(os.homedir(), '.ocpr')

function parseArgs() {
  const args = {
    label: 'run',
    worktrees: 8,
    scrollbackLines: 5000,
    reportPath: null,
    keep: false
  }
  for (const arg of process.argv.slice(2)) {
    if (arg === '--help' || arg === '-h') {
      console.log(
        'Usage: node tools/benchmarks/terminal-cold-park-resource-bench.mjs [--label=name] [--worktrees=N] [--scrollback-lines=N] [--report=path] [--keep]'
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
    } else if (name === '--worktrees') {
      args.worktrees = Math.max(2, Number(value) || 8)
    } else if (name === '--scrollback-lines') {
      args.scrollbackLines = Math.max(0, Number(value) || 0)
    } else if (name === '--report') {
      args.reportPath = value
    }
  }
  return args
}

function git(cwd, ...cmd) {
  execFileSync('git', cmd, { cwd, stdio: 'pipe' })
}

function createShortUserDataDirectory() {
  mkdirSync(shortRoot, { recursive: true })
  const userDataDir = mkdtempSync(path.join(shortRoot, 'ud-'))
  createCompletedOnboardingProfile(userDataDir)
  return userDataDir
}

function createLocalRepoFixture(worktreeCount) {
  mkdirSync(shortRoot, { recursive: true })
  const baseDir = mkdtempSync(path.join(shortRoot, 'fx-'))
  const repoPath = path.join(baseDir, 'repo')
  mkdirSync(repoPath, { recursive: true })
  git(repoPath, 'init', '--initial-branch=main')
  git(repoPath, 'config', 'user.email', 'bench@orca.local')
  git(repoPath, 'config', 'user.name', 'Orca Bench')
  writeFileSync(path.join(repoPath, 'README.md'), '# cold-park resource fixture\n')
  git(repoPath, 'add', '.')
  git(repoPath, 'commit', '-m', 'init', '--no-gpg-sign')
  const worktreePaths = []
  for (let i = 0; i < worktreeCount; i++) {
    const worktreePath = path.join(baseDir, `wt-${i}`)
    git(repoPath, 'worktree', 'add', worktreePath, '-b', `wt-${i}`)
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
          return { repoId: repo.id }
        },
        { repoPath: fixture.repoPath, importedWorktreePaths: fixture.worktreePaths }
      ),
    setupTimeoutMs
  )
}

async function listWorktrees(page, repoId) {
  return page.evaluate(async (id) => {
    await window.__store
      ?.getState?.()
      ?.fetchWorktrees?.(id, { requireAuthoritative: true })
      .catch(() => undefined)
    const state = window.__store?.getState?.()
    const list = state?.worktreesByRepo?.[id] ?? []
    return list.map((w) => ({
      id: w.id,
      path: w.path,
      isMainWorktree: w.isMainWorktree
    }))
  }, repoId)
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

async function primeScrollback(page, worktreeId, lineCount) {
  if (lineCount <= 0) {
    return 0
  }
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
    return 0
  }
  const cmd = `awk 'BEGIN{for(i=0;i<${lineCount};i++)printf "%04d %s\\n", i, "cold-park-resource-scrollback-priming-line-padding-to-eighty-cols"}'\n`
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
        return (pane?.serializeAddon?.serialize?.() ?? '').length
      }, worktreeId),
    (len) => Number.isFinite(len) && len > lineCount * 30,
    20_000,
    100
  ).catch(() => 0)
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function setParkingEnabled(page, enabled) {
  await page.evaluate(async (value) => {
    const store = window.__store
    await store.getState().updateSettings?.({ terminalHiddenViewParking: value })
  }, enabled)
}

const toMB = (bytes) => (bytes == null ? null : Math.round((bytes / 1048576) * 10) / 10)

/** Force GC repeatedly (detached xterm buffers are typed arrays that GC lazily),
 *  then read whole-app process memory (main+renderer via getAppMetrics), renderer
 *  JS heap, and pane/WebGL counts. */
async function measureResources(page, cdp) {
  // Why: one collectGarbage rarely reclaims freshly detached xterm typed-array
  // buffers; drive several passes with settle gaps so the parked delta reflects
  // reclaimed memory, not GC lag.
  for (let i = 0; i < 4; i++) {
    await cdp.send('HeapProfiler.collectGarbage').catch(() => undefined)
    await sleep(400)
  }
  const metrics = await cdp.send('Performance.getMetrics').catch(() => ({ metrics: [] }))
  const metricMap = Object.fromEntries((metrics.metrics ?? []).map((m) => [m.name, m.value]))
  const renderer = await page.evaluate(async () => {
    const managers = window.__paneManagers
    let attachedWebgl = 0
    let paneCount = 0
    for (const [, manager] of managers?.entries?.() ?? []) {
      const diags = manager?.getRenderingDiagnostics?.() ?? []
      paneCount += diags.length
      for (const d of diags) {
        if (d.hasWebgl) {
          attachedWebgl += 1
        }
      }
    }
    const mem = performance?.memory ?? null
    // Whole-app process memory (main + renderer + other) from getAppMetrics —
    // the number that captures the daemon-snapshot cost the renderer heap can't.
    const snapshot = await window.api?.memory?.getSnapshot?.().catch(() => null)
    return {
      paneManagerCount: managers?.size ?? 0,
      terminalPaneCount: paneCount,
      attachedWebglContexts: attachedWebgl,
      rendererJsHeapUsedMB: mem ? Math.round((mem.usedJSHeapSize / 1048576) * 10) / 10 : null,
      appMemory: snapshot?.app
        ? {
            totalMB: Math.round(((snapshot.app.memory ?? 0) / 1048576) * 10) / 10,
            mainMB: Math.round(((snapshot.app.main?.memory ?? 0) / 1048576) * 10) / 10,
            rendererMB: Math.round(((snapshot.app.renderer?.memory ?? 0) / 1048576) * 10) / 10,
            otherMB: Math.round(((snapshot.app.other?.memory ?? 0) / 1048576) * 10) / 10
          }
        : null
    }
  })
  return {
    ...renderer,
    cdpJsHeapUsedMB: toMB(metricMap.JSHeapUsedSize),
    cdpNodes: metricMap.Nodes ?? null,
    cdpLayoutCount: metricMap.LayoutCount ?? null
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
    args: { worktrees: args.worktrees, scrollbackLines: args.scrollbackLines },
    states: {},
    cleanupErrors: []
  }
  let fixture = null
  let userDataDir = null
  let launched = null
  let browser = null
  let page = null
  try {
    fixture = createLocalRepoFixture(args.worktrees)
    const cdpPort = await pickFreePort()
    userDataDir = createShortUserDataDirectory()
    process.env.ORCA_E2E_TERMINAL_PARKING_DELAY_MS = String(PARK_DELAY_MS)
    console.log(
      `[cold-park-res] fixture=${fixture.baseDir} userData=${userDataDir} cdp=${cdpPort} worktrees=${args.worktrees}`
    )
    launched = launchDevApp({ cdpPort, userDataDir })
    const connected = await connectToApp(cdpPort)
    browser = connected.browser
    page = connected.page
    const cdp = await page.context().newCDPSession(page)
    await cdp.send('Performance.enable').catch(() => undefined)
    await cdp.send('HeapProfiler.enable').catch(() => undefined)
    await waitForStoreReady(page)
    await installRendererProbe(page)
    const setup = await setupWorkspaces(page, fixture)
    const worktrees = await pollUntil(
      'worktrees registered',
      () => listWorktrees(page, setup.repoId),
      (list) => Array.isArray(list) && list.length >= args.worktrees,
      45_000,
      500
    )
    console.log(`[cold-park-res] ${worktrees.length} worktrees registered`)
    const primary = worktrees.find((w) => w.isMainWorktree) ?? worktrees[0]
    const anotherWorktree = worktrees.find((w) => w.id !== primary.id)

    // Ensure parking is OFF while we mount + prime every terminal, so all N
    // stay fully mounted for the baseline measurement.
    await setParkingEnabled(page, false)
    for (const wt of worktrees) {
      await activateWorktreeTerminal(page, wt.id)
      await waitForBoundTerminal(page, wt.id)
      await primeScrollback(page, wt.id, args.scrollbackLines)
    }
    // Foreground the primary; the other N-1 are now backgrounded but — with
    // parking OFF — still fully mounted.
    await activateWorktreeTerminal(page, primary.id)
    await sleep(SETTLE_AFTER_PARK_MS)
    report.states.parkingOff = await measureResources(page, cdp)
    console.log(`[cold-park-res] parkingOff: ${JSON.stringify(report.states.parkingOff)}`)

    // Turn parking ON; the backgrounded worktrees pass the shrunk hysteresis
    // and park. Nudge a re-evaluation by toggling focus so the park timers arm.
    await setParkingEnabled(page, true)
    await sleep(PARK_DELAY_MS + 500)
    // Re-focus primary to trigger the park policy effect re-run for the others.
    await activateWorktreeTerminal(page, anotherWorktree.id)
    await activateWorktreeTerminal(page, primary.id)
    await sleep(SETTLE_AFTER_PARK_MS)
    report.states.parkingOn = await measureResources(page, cdp)
    console.log(`[cold-park-res] parkingOn: ${JSON.stringify(report.states.parkingOn)}`)

    const off = report.states.parkingOff
    const on = report.states.parkingOn
    const subMB = (a, b) => (a != null && b != null ? Math.round((a - b) * 10) / 10 : null)
    report.delta = {
      paneManagersReleased: off.paneManagerCount - on.paneManagerCount,
      webglContextsReleased: off.attachedWebglContexts - on.attachedWebglContexts,
      cdpJsHeapSavedMB: subMB(off.cdpJsHeapUsedMB, on.cdpJsHeapUsedMB),
      rendererJsHeapSavedMB: subMB(off.rendererJsHeapUsedMB, on.rendererJsHeapUsedMB),
      appTotalSavedMB: subMB(off.appMemory?.totalMB, on.appMemory?.totalMB),
      appRendererSavedMB: subMB(off.appMemory?.rendererMB, on.appMemory?.rendererMB),
      appMainSavedMB: subMB(off.appMemory?.mainMB, on.appMemory?.mainMB),
      domNodesReleased:
        off.cdpNodes != null && on.cdpNodes != null ? off.cdpNodes - on.cdpNodes : null
    }
    report.finalDiagnostics = await collectRendererDiagnostics(page)
  } finally {
    report.elapsedMs = Date.now() - startedAt
    if (browser) {
      await browser.close().catch(() => undefined)
    }
    if (launched) {
      try {
        await stopDevApp(launched.child)
        // Why: stopDevApp SIGTERMs only the top-level vite child on macOS/Linux;
        // the spawned electron process tree (main, GPU, renderer, helpers)
        // survives and accumulates across runs until the machine saturates.
        // Best-effort reap the whole tree rooted at the launcher pid.
        if (launched.child?.pid && process.platform !== 'win32') {
          try {
            execFileSync('pkill', ['-9', '-P', String(launched.child.pid)], { stdio: 'ignore' })
          } catch {
            /* no descendants left — fine */
          }
        }
      } catch (error) {
        report.cleanupErrors.push(error instanceof Error ? error.message : String(error))
      }
      report.appLogsTail = launched.logs.slice(-40)
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
          `cold-park-res-${args.label}-${stamp}.json`
        )
    )
    mkdirSync(path.dirname(reportPath), { recursive: true })
    writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`)
    console.log(`[cold-park-res] report=${reportPath}`)
    if (report.delta) {
      const d = report.delta
      console.log(
        `[cold-park-res] DELTA (off−on): paneManagers=${d.paneManagersReleased} webglContexts=${d.webglContextsReleased} domNodes=${d.domNodesReleased}`
      )
      console.log(
        `[cold-park-res]   memory saved: appTotal=${d.appTotalSavedMB}MB (renderer=${d.appRendererSavedMB}MB main=${d.appMainSavedMB}MB) rendererJsHeap=${d.rendererJsHeapSavedMB}MB cdpJsHeap=${d.cdpJsHeapSavedMB}MB`
      )
      if (report.states.parkingOff?.appMemory && report.states.parkingOn?.appMemory) {
        console.log(
          `[cold-park-res]   appTotal off=${report.states.parkingOff.appMemory.totalMB}MB on=${report.states.parkingOn.appMemory.totalMB}MB`
        )
      }
    }
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error))
  process.exit(1)
})
