#!/usr/bin/env node
// Terminal interaction latency benchmark: tab creation, tab switching, and
// workspace switching against the real Electron dev app over CDP. Produces
// median/p95 phase timings so Windows terminal slowness can be attributed to
// store work, PTY spawn, shell startup, or renderer paint — not guessed at.

import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import {
  collectRendererDiagnostics,
  connectToApp,
  createGpuUserDataDirectory,
  installRendererProbe,
  launchDevApp,
  pickFreePort,
  stopDevApp,
  waitForStoreReady
} from '../../config/scripts/windows-apphang-repro/electron-dev-session.mjs'
import {
  pollUntil,
  rendererActionTimeoutMs,
  runWithTimeout,
  setupTimeoutMs
} from '../../config/scripts/windows-apphang-repro/repro-timing.mjs'
import { safeRemoveLocalDirectory } from '../../config/scripts/windows-apphang-repro/wsl-workspace-fixture.mjs'

const rootDir = path.resolve(fileURLToPath(new URL('../..', import.meta.url)))
const scenarioTimeoutMs = 300_000
const defaultIterations = 8
const defaultSwitches = 24
const defaultCycles = 12

function parseArgs() {
  const args = {
    label: 'run',
    iterations: defaultIterations,
    switches: defaultSwitches,
    cycles: defaultCycles,
    shell: null,
    scenarios: ['tab-create', 'tab-switch', 'workspace-switch'],
    reportPath: null,
    keep: false
  }
  for (const arg of process.argv.slice(2)) {
    if (arg === '--help' || arg === '-h') {
      printHelp()
      process.exit(0)
    }
    if (arg === '--keep') {
      args.keep = true
      continue
    }
    const [name, value] = arg.split('=', 2)
    if (name === '--label') {
      args.label = value?.trim() || 'run'
      continue
    }
    if (name === '--iterations') {
      args.iterations = parsePositiveInt(name, value)
      continue
    }
    if (name === '--switches') {
      args.switches = parsePositiveInt(name, value)
      continue
    }
    if (name === '--cycles') {
      args.cycles = parsePositiveInt(name, value)
      continue
    }
    if (name === '--shell') {
      args.shell = value?.trim() || null
      continue
    }
    if (name === '--scenarios') {
      const scenarios = (value ?? '')
        .split(',')
        .map((entry) => entry.trim())
        .filter(Boolean)
      const known = new Set(['tab-create', 'tab-switch', 'workspace-switch'])
      if (scenarios.length === 0 || scenarios.some((scenario) => !known.has(scenario))) {
        throw new Error(
          `Unsupported --scenarios=${value}. Use tab-create,tab-switch,workspace-switch.`
        )
      }
      args.scenarios = scenarios
      continue
    }
    if (name === '--report') {
      args.reportPath = value?.trim() || null
      continue
    }
    throw new Error(`Unknown argument: ${arg}`)
  }
  return args
}

function printHelp() {
  console.log(`Usage:
  node tools/benchmarks/terminal-perf-bench.mjs [options]

Options:
  --label=NAME             Label recorded in the report filename/JSON. Default: run.
  --iterations=N           Terminal tab create/close iterations. Default: ${defaultIterations}.
  --switches=N             Tab switch alternations. Default: ${defaultSwitches}.
  --cycles=N               Workspace switch cycles. Default: ${defaultCycles}.
  --shell=PATH             Shell override for created tabs (e.g. cmd.exe). Default: app default.
  --scenarios=a,b          Subset of tab-create,tab-switch,workspace-switch.
  --report=PATH            Report JSON path. Default: tools/benchmarks/results/terminal-perf-<label>-<ts>.json.
  --keep                   Keep the temp fixture and user data dir.`)
}

function parsePositiveInt(name, value) {
  const parsed = Number.parseInt(value ?? '', 10)
  if (!Number.isInteger(parsed) || parsed <= 0 || String(parsed) !== value) {
    throw new Error(`${name} requires a positive integer.`)
  }
  return parsed
}

function git(cwd, ...cmd) {
  execFileSync('git', cmd, { cwd, stdio: 'pipe' })
}

/** Local (native-path) git repo with two external worktrees — three workspace
 *  cards total. Native paths keep the benchmark portable and representative of
 *  the default local workflow, unlike the WSL-specific apphang fixture. */
function createLocalRepoFixture() {
  const baseDir = mkdtempSync(path.join(os.tmpdir(), 'orca-termperf-'))
  const repoPath = path.join(baseDir, 'repo')
  mkdirSync(repoPath, { recursive: true })
  git(repoPath, 'init', '--initial-branch=main')
  git(repoPath, 'config', 'user.email', 'bench@orca.local')
  git(repoPath, 'config', 'user.name', 'Orca Bench')
  writeFileSync(path.join(repoPath, 'README.md'), '# terminal perf fixture\n')
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
          const repo =
            state.repos.find((candidate) => candidate.path === repoPath) ?? addResult.repo
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
            worktrees: worktrees.map((worktree) => ({
              id: worktree.id,
              path: worktree.path,
              displayName: worktree.displayName,
              isMainWorktree: worktree.isMainWorktree
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
        const row = rows.find((candidate) => candidate.getAttribute('data-worktree-id') === id)
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

async function activateWorktree(page, worktreeId) {
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

/** Runs entirely in the renderer so phase timestamps come from one
 *  performance.now() clock with no CDP round-trip skew. */
async function runTabCreateScenario(page, worktreeId, iterations, shell) {
  return await runWithTimeout(
    'tab-create scenario',
    () =>
      page.evaluate(
        async ({ worktreeId, iterations, shell }) => {
          const store = window.__store
          const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
          const raf2 = () =>
            new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
          const longtasks = []
          const observer = new PerformanceObserver((list) => {
            for (const entry of list.getEntries()) {
              longtasks.push(entry.duration)
            }
          })
          observer.observe({ entryTypes: ['longtask'] })
          const samples = []
          for (let index = 0; index < iterations; index++) {
            const t0 = performance.now()
            const tab = store.getState().createTab(worktreeId, undefined, shell ?? undefined)
            const tCreated = performance.now()
            const readPane = () => {
              const manager = window.__paneManagers?.get(tab.id)
              return manager?.getActivePane?.() ?? manager?.getPanes?.()?.[0] ?? null
            }
            let ptyId = null
            while (!ptyId && performance.now() - t0 < 60_000) {
              ptyId = readPane()?.container?.dataset?.ptyId ?? null
              if (!ptyId) {
                await sleep(5)
              }
            }
            const tPty = performance.now()
            let sawOutput = false
            while (!sawOutput && performance.now() - t0 < 60_000) {
              const content = readPane()?.serializeAddon?.serialize?.() ?? ''
              sawOutput = content.trim().length > 0
              if (!sawOutput) {
                await sleep(10)
              }
            }
            const tOutput = performance.now()
            await raf2()
            const tPainted = performance.now()
            samples.push({
              index,
              storeCreateMs: tCreated - t0,
              ptyBindMs: tPty - t0,
              firstOutputMs: tOutput - t0,
              paintSettleMs: tPainted - t0,
              timedOut: !ptyId || !sawOutput
            })
            store.getState().closeTab(tab.id)
            await sleep(400)
          }
          observer.disconnect()
          return { samples, longtasks }
        },
        { worktreeId, iterations, shell }
      ),
    scenarioTimeoutMs
  )
}

/** K tabs are created up-front (PTY bound), then activation alternates across
 *  them. switchMs = setActiveTab call → active pane manager/pane for the new
 *  tab present → two RAFs (paint settled). */
async function runTabSwitchScenario(page, worktreeId, switches, shell) {
  return await runWithTimeout(
    'tab-switch scenario',
    () =>
      page.evaluate(
        async ({ worktreeId, switches, shell }) => {
          const store = window.__store
          const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
          const raf2 = () =>
            new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
          const tabCount = 4
          const tabs = []
          for (let index = 0; index < tabCount; index++) {
            const tab = store.getState().createTab(worktreeId, undefined, shell ?? undefined)
            tabs.push(tab.id)
            const started = performance.now()
            let bound = false
            while (!bound && performance.now() - started < 60_000) {
              const manager = window.__paneManagers?.get(tab.id)
              const pane = manager?.getActivePane?.() ?? manager?.getPanes?.()?.[0] ?? null
              bound = Boolean(pane?.container?.dataset?.ptyId)
              if (!bound) {
                await sleep(10)
              }
            }
          }
          await sleep(500)
          const longtasks = []
          const observer = new PerformanceObserver((list) => {
            for (const entry of list.getEntries()) {
              longtasks.push(entry.duration)
            }
          })
          observer.observe({ entryTypes: ['longtask'] })
          const samples = []
          for (let index = 0; index < switches; index++) {
            const targetTabId = tabs[index % tabs.length]
            if (store.getState().activeTabId === targetTabId) {
              continue
            }
            const t0 = performance.now()
            store.getState().setActiveTab(targetTabId)
            const tStore = performance.now()
            let visible = false
            while (!visible && performance.now() - t0 < 10_000) {
              const manager = window.__paneManagers?.get(targetTabId)
              const pane = manager?.getActivePane?.() ?? manager?.getPanes?.()?.[0] ?? null
              visible = Boolean(pane?.container?.isConnected)
              if (!visible) {
                await sleep(2)
              }
            }
            const tVisible = performance.now()
            await raf2()
            const tPainted = performance.now()
            samples.push({
              index,
              targetTabId,
              storeMs: tStore - t0,
              paneVisibleMs: tVisible - t0,
              paintSettleMs: tPainted - t0,
              timedOut: !visible
            })
            await sleep(120)
          }
          observer.disconnect()
          for (const tabId of tabs) {
            store.getState().closeTab(tabId)
          }
          return { samples, longtasks }
        },
        { worktreeId, switches, shell }
      ),
    scenarioTimeoutMs
  )
}

async function runWorkspaceSwitchScenario(page, worktreeIds, cycles) {
  const samples = []
  for (let index = 0; index < cycles; index++) {
    const worktreeId = worktreeIds[index % worktreeIds.length]
    const t0 = Date.now()
    await clickWorktreeCard(page, worktreeId)
    await pollUntil(
      `workspace activation ${worktreeId}`,
      () =>
        page.evaluate((id) => {
          const state = window.__store?.getState?.()
          return state?.activeWorktreeId === id && state.activeTabType === 'terminal'
        }, worktreeId),
      Boolean,
      30_000,
      10
    )
    const activationMs = Date.now() - t0
    const pty = await pollUntil(
      `workspace pty ${worktreeId}`,
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
    const ptyBindMs = Date.now() - t0
    await runWithTimeout(
      'paint settle',
      () =>
        page.evaluate(
          () =>
            new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
        ),
      rendererActionTimeoutMs
    )
    const paintSettleMs = Date.now() - t0
    samples.push({ index, worktreeId, ptyId: pty, activationMs, ptyBindMs, paintSettleMs })
  }
  return { samples }
}

function summarize(values) {
  const sorted = values.filter((value) => Number.isFinite(value)).sort((a, b) => a - b)
  if (sorted.length === 0) {
    return null
  }
  const at = (fraction) =>
    sorted[Math.min(sorted.length - 1, Math.round(fraction * (sorted.length - 1)))]
  return {
    count: sorted.length,
    median: Math.round(at(0.5)),
    p95: Math.round(at(0.95)),
    max: Math.round(sorted.at(-1))
  }
}

function summarizeScenario(name, result) {
  if (!result) {
    return null
  }
  const fields = {}
  const keys = new Set()
  // Why: a timed-out sample carries its timeout ceiling as the measurement,
  // which would masquerade as a giant latency in median/p95/max. Timeouts are
  // reported through the separate timedOut count instead.
  const completedSamples = result.samples.filter((sample) => !sample.timedOut)
  for (const sample of completedSamples) {
    for (const [key, value] of Object.entries(sample)) {
      if (typeof value === 'number' && key !== 'index') {
        keys.add(key)
      }
    }
  }
  for (const key of keys) {
    fields[key] = summarize(completedSamples.map((sample) => sample[key]))
  }
  const longtasks = result.longtasks ?? []
  return {
    name,
    samples: result.samples.length,
    timedOut: result.samples.filter((sample) => sample.timedOut).length,
    fields,
    longtaskCount: longtasks.length,
    longtaskMaxMs: longtasks.length ? Math.round(Math.max(...longtasks)) : 0
  }
}

async function main() {
  const args = parseArgs()
  const startedAt = Date.now()
  // Why: the report and clocks exist before any setup so a launch/setup
  // failure still produces a report and reaches the cleanup below.
  const report = {
    label: args.label,
    startedAt: new Date(startedAt).toISOString(),
    platform: `${process.platform} ${os.release()}`,
    shell: args.shell ?? 'default',
    args: { iterations: args.iterations, switches: args.switches, cycles: args.cycles },
    scenarios: {},
    summaries: [],
    finalDiagnostics: null,
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
    userDataDir = createGpuUserDataDirectory('bench')
    console.log(`[terminal-perf] fixture=${fixture.baseDir} userData=${userDataDir} cdp=${cdpPort}`)
    launched = launchDevApp({ cdpPort, userDataDir })
    const connected = await connectToApp(cdpPort)
    browser = connected.browser
    page = connected.page
    await waitForStoreReady(page)
    await installRendererProbe(page)
    const setup = await setupWorkspaces(page, fixture)
    const worktrees = setup.worktrees
    if (worktrees.length < 2) {
      throw new Error(`Expected >=2 worktrees, got ${worktrees.length}`)
    }
    const primary = worktrees.find((worktree) => worktree.isMainWorktree) ?? worktrees[0]
    await activateWorktree(page, primary.id)

    if (args.scenarios.includes('tab-create')) {
      console.log(`[terminal-perf] scenario=tab-create iterations=${args.iterations}`)
      report.scenarios['tab-create'] = await runTabCreateScenario(
        page,
        primary.id,
        args.iterations,
        args.shell
      )
    }
    if (args.scenarios.includes('tab-switch')) {
      console.log(`[terminal-perf] scenario=tab-switch switches=${args.switches}`)
      report.scenarios['tab-switch'] = await runTabSwitchScenario(
        page,
        primary.id,
        args.switches,
        args.shell
      )
    }
    if (args.scenarios.includes('workspace-switch')) {
      console.log(`[terminal-perf] scenario=workspace-switch cycles=${args.cycles}`)
      const targets = worktrees.slice(0, 3).map((worktree) => worktree.id)
      report.scenarios['workspace-switch'] = await runWorkspaceSwitchScenario(
        page,
        targets,
        args.cycles
      )
    }
    report.finalDiagnostics = await collectRendererDiagnostics(page)
  } finally {
    report.elapsedMs = Date.now() - startedAt
    for (const [name, result] of Object.entries(report.scenarios)) {
      const summary = summarizeScenario(name, result)
      if (summary) {
        report.summaries.push(summary)
      }
    }
    if (browser) {
      await browser.close().catch(() => undefined)
    }
    if (launched) {
      // Why: a shutdown failure must not abort the rest of teardown — the
      // report still gets written and temp dirs still get removed.
      try {
        await stopDevApp(launched.child)
      } catch (error) {
        report.cleanupErrors.push(error instanceof Error ? error.message : String(error))
      }
      report.appLogsTail = launched.logs.slice(-80)
      // Main-process phase attribution (requires ORCA_PTY_SPAWN_TIMING=1 in the
      // benchmark's environment; launchDevApp inherits it into the app).
      report.ptySpawnTimings = launched.logs
        .filter((entry) => entry.line.includes('[pty-spawn-timing]'))
        .map((entry) => entry.line.slice(entry.line.indexOf('[pty-spawn-timing]')))
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
          `terminal-perf-${args.label}-${stamp}.json`
        )
    )
    mkdirSync(path.dirname(reportPath), { recursive: true })
    writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`)
    console.log(`[terminal-perf] report=${reportPath}`)
    for (const summary of report.summaries) {
      console.log(
        `[terminal-perf] ${summary.name}: samples=${summary.samples} timedOut=${summary.timedOut} longtasks=${summary.longtaskCount} (max ${summary.longtaskMaxMs}ms)`
      )
      for (const [field, stats] of Object.entries(summary.fields)) {
        if (stats) {
          console.log(
            `[terminal-perf]   ${field}: median=${stats.median}ms p95=${stats.p95}ms max=${stats.max}ms`
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
