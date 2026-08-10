#!/usr/bin/env node
/**
 * A/B benchmark for worktree deletion against real Orca dev instances.
 *
 * Usage:
 *   pnpm bench:worktree-deletion -- --instance baseline=/path/to/main \
 *     --instance candidate=. --iterations 3 --history-files 10000
 */
import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
// Why @playwright/test, not playwright: only the former is a declared devDependency; it re-exports
// the same browser types, so the benchmark resolves without relying on a hoisted transitive install.
import { chromium } from '@playwright/test'
import * as branchFixture from './worktree-deletion-branch-fixture.mjs'

const DEFAULT_ITERATIONS = 3
const DEFAULT_HISTORY_FILES = 10_000
const DEFAULT_FETCH_DELAY_MS = 1_500
const CDP_START_PORT = 9_700
const START_TIMEOUT_MS = 180_000
const IPC_TIMEOUT_MS = 90_000
const resultsRoot = path.resolve(import.meta.dirname, 'results')

function parseArgs(argv) {
  const options = {
    instances: [],
    iterations: DEFAULT_ITERATIONS,
    historyFiles: DEFAULT_HISTORY_FILES,
    fetchDelayMs: DEFAULT_FETCH_DELAY_MS,
    keepFixture: false
  }
  for (let index = 2; index < argv.length; index += 1) {
    const value = argv[index]
    if (value === '--') {
      continue
    }
    if (value === '--help' || value === '-h') {
      printHelp()
      process.exit(0)
    }
    if (value === '--keep-fixture') {
      options.keepFixture = true
      continue
    }
    const next = () => {
      const result = argv[++index]
      if (!result) {
        throw new Error(`${value} needs a value`)
      }
      return result
    }
    if (value === '--instance') {
      const entry = next()
      const separator = entry.indexOf('=')
      if (separator <= 0) {
        throw new Error('--instance must use label=/absolute/or/relative/path')
      }
      options.instances.push({
        label: entry.slice(0, separator),
        repoRoot: path.resolve(entry.slice(separator + 1))
      })
    } else if (value === '--iterations') {
      options.iterations = readPositiveInteger(value, next())
    } else if (value === '--history-files') {
      options.historyFiles = readPositiveInteger(value, next())
    } else if (value === '--fetch-delay-ms') {
      options.fetchDelayMs = readPositiveInteger(value, next())
    } else {
      throw new Error(`Unknown argument: ${value}`)
    }
  }
  if (options.instances.length === 0) {
    options.instances.push({ label: 'candidate', repoRoot: process.cwd() })
  }
  return options
}

function readPositiveInteger(flag, value) {
  const number = Number(value)
  if (!Number.isInteger(number) || number < 1) {
    throw new Error(`${flag} must be a positive integer`)
  }
  return number
}

function printHelp() {
  console.log(`Usage:
  pnpm bench:worktree-deletion -- [options]

Options:
  --instance <label=path>  Dev checkout to launch; repeat for A/B comparison
  --iterations <count>     Deletions per instance (default: ${DEFAULT_ITERATIONS})
  --history-files <count>  Files seeded in each worktree history (default: ${DEFAULT_HISTORY_FILES})
  --fetch-delay-ms <ms>    Slow-remote delay for branch cleanup (default: ${DEFAULT_FETCH_DELAY_MS})
  --keep-fixture           Keep disposable profiles and repos for inspection`)
}

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8' })
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(' ')} failed (${result.status})\n${result.stderr || result.stdout}`
    )
  }
}

function createFixture(instanceLabel) {
  const root = mkdtempSync(path.join(os.tmpdir(), `orca-delete-bench-${instanceLabel}-`))
  const repoPath = path.join(root, 'repo')
  const userDataPath = path.join(root, 'user-data')
  mkdirSync(repoPath)
  mkdirSync(userDataPath)
  // Git 2.25 lacks `git init --initial-branch`; rename after the first commit below.
  run('git', ['init'], repoPath)
  run('git', ['config', 'user.email', 'worktree-delete-bench@orca.invalid'], repoPath)
  run('git', ['config', 'user.name', 'Orca Worktree Delete Bench'], repoPath)
  writeFileSync(path.join(repoPath, 'README.md'), '# Orca worktree deletion benchmark\n')
  run('git', ['add', 'README.md'], repoPath)
  run('git', ['commit', '-m', 'Initialize benchmark fixture', '--no-gpg-sign'], repoPath)
  run('git', ['branch', '-m', 'main'], repoPath)
  branchFixture.initializeBranchCleanupRemote(root, repoPath)
  return { root, repoPath, userDataPath }
}

function launchDevInstance({ label, repoRoot }, fixture, port) {
  if (!existsSync(path.join(repoRoot, 'package.json'))) {
    throw new Error(`${label}: package.json not found under ${repoRoot}`)
  }
  const env = {
    ...process.env,
    ORCA_DEV_USER_DATA_PATH: fixture.userDataPath,
    REMOTE_DEBUGGING_PORT: String(port)
  }
  delete env.ELECTRON_RUN_AS_NODE
  const child = spawn(process.execPath, ['config/scripts/run-electron-vite-dev.mjs'], {
    cwd: repoRoot,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    // Why: own process group so teardown can signal the Electron/Vite grandchildren, not just the launcher.
    detached: process.platform !== 'win32',
    windowsHide: true
  })
  const log = { stdout: '', stderr: '' }
  child.stdout?.on('data', (chunk) => {
    log.stdout = appendLog(log.stdout, chunk)
  })
  child.stderr?.on('data', (chunk) => {
    log.stderr = appendLog(log.stderr, chunk)
  })
  return { child, endpoint: `http://127.0.0.1:${port}`, label, log }
}

function appendLog(current, chunk) {
  return `${current}${String(chunk)}`.slice(-30_000)
}

async function connectToOrca(instance) {
  const deadline = Date.now() + START_TIMEOUT_MS
  let lastError = null
  while (Date.now() < deadline) {
    if (instance.child.exitCode !== null) {
      throw new Error(
        `${instance.label}: dev process exited (${instance.child.exitCode})\n${instance.log.stderr}`
      )
    }
    try {
      const browser = await chromium.connectOverCDP(instance.endpoint)
      try {
        // CDP answers long before the renderer exposes window.__store; without this, every
        // findOrcaPage timeout drops a live browser handle and leaks a connection per retry.
        const page = await findOrcaPage(browser)
        return { browser, page }
      } catch (error) {
        await browser.close().catch(() => undefined)
        throw error
      }
    } catch (error) {
      lastError = error
      await delay(500)
    }
  }
  throw new Error(
    `${instance.label}: CDP did not become ready: ${String(lastError)}\n${instance.log.stderr}`
  )
}

async function findOrcaPage(browser) {
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    for (const context of browser.contexts()) {
      for (const page of context.pages()) {
        const ready = await page
          .evaluate(() => Boolean(window.__store && window.api?.repos?.list))
          .catch(() => false)
        if (ready) {
          return page
        }
      }
    }
    await delay(250)
  }
  throw new Error('Orca renderer with window.__store was not found')
}

async function addFixtureRepo(page, repoPath) {
  const addedRepo = await page.evaluate(async (fixturePath) => {
    const store = window.__store
    if (!store) {
      throw new Error('window.__store is unavailable')
    }
    const repo = await store.getState().addRepoPath(fixturePath)
    if (!repo) {
      throw new Error(`Could not add fixture repo ${fixturePath}`)
    }
    return { id: repo.id, path: repo.path }
  }, repoPath)
  return page.evaluate(
    async ({ fixtureRepoId, fixturePath }) => {
      const store = window.__store
      if (!store) {
        throw new Error('window.__store is unavailable')
      }
      let rootWorktree
      for (let attempt = 0; attempt < 60 && !rootWorktree; attempt += 1) {
        await store.getState().fetchWorktrees(fixtureRepoId)
        await new Promise((resolve) => window.setTimeout(resolve, 250))
        rootWorktree = store
          .getState()
          .worktreesByRepo[fixtureRepoId]?.find((worktree) => worktree.path === fixturePath)
      }
      if (!rootWorktree) {
        throw new Error('Fixture root worktree did not load')
      }
      const state = store.getState()
      state.setSidebarOpen(true)
      state.setShowActiveOnly(false)
      state.setShowSleepingWorkspaces(true)
      state.setHideDefaultBranchWorkspace(false)
      state.setFilterRepoIds([])
      state.setActiveRepo(fixtureRepoId)
      state.setActiveWorktree(rootWorktree.id)
      return { repoId: fixtureRepoId, rootWorktreeId: rootWorktree.id }
    },
    { fixtureRepoId: addedRepo.id, fixturePath: addedRepo.path }
  )
}

async function createMeasuredWorktree(page, repoId, iteration) {
  return page.evaluate(
    async ({ fixtureRepoId, sequence }) => {
      const store = window.__store
      if (!store) {
        throw new Error('window.__store is unavailable')
      }
      const result = await store
        .getState()
        .createWorktree(fixtureRepoId, `delete-bench-${sequence}-${Date.now()}`)
      await store.getState().fetchWorktrees(fixtureRepoId)
      const state = store.getState()
      const tab = state.createTab(result.worktree.id)
      state.createBrowserTab(result.worktree.id, 'about:blank', {
        title: 'worktree deletion regression probe',
        activate: false
      })
      state.setActiveView('terminal')
      state.setActiveWorktree(result.worktree.id)
      state.setActiveTab(tab.id)
      state.setRightSidebarTab('explorer')
      state.setRightSidebarOpen(true)
      state.revealWorktreeInSidebar(result.worktree.id, { behavior: 'auto' })
      // Let the terminal and explorer install their real PTY/watcher resources before deletion.
      await new Promise((resolve) => window.setTimeout(resolve, 500))
      return { id: result.worktree.id, path: result.worktree.path }
    },
    { fixtureRepoId: repoId, sequence: iteration }
  )
}

function seedTerminalHistory(userDataPath, worktreeId, fileCount) {
  const hash = createHash('sha256').update(worktreeId).digest('hex').slice(0, 16)
  const historyPath = path.join(userDataPath, 'terminal-history', hash)
  const payload = 'worktree deletion benchmark history\n'.repeat(4)
  for (let index = 0; index < fileCount; index += 1) {
    const bucket = path.join(historyPath, String(Math.floor(index / 250)))
    if (index % 250 === 0) {
      mkdirSync(bucket, { recursive: true })
    }
    writeFileSync(path.join(bucket, `${index}.history`), payload)
  }
  return historyPath
}

async function assertWorktreeRowVisible(page, worktreeId) {
  await page.waitForFunction(
    (id) =>
      [...document.querySelectorAll('[data-worktree-id]')].some(
        (element) => element.getAttribute('data-worktree-id') === id
      ),
    worktreeId
  )
}

async function measureDeletion(page, worktreeId, rootWorktreeId) {
  return page.evaluate(
    async ({ targetId, fallbackId, ipcTimeoutMs }) => {
      const store = window.__store
      if (!store) {
        throw new Error('window.__store is unavailable')
      }
      store.getState().setActiveWorktree(fallbackId)
      let settled = false
      let failure = null
      const startedAt = performance.now()
      const deletion = store
        .getState()
        .removeWorktree(targetId, true)
        .then((result) => {
          settled = true
          return result
        })
        .catch((error) => {
          // Why: without this the poll loop below spins forever on a rejected delete — the exact
          // failure this benchmark exists to surface would read as a hang.
          settled = true
          failure = error
          return null
        })
      const ipcSamplesMs = []
      let maxRendererTimerDriftMs = 0
      let expectedTimerAt = performance.now() + 10
      while (!settled) {
        await new Promise((resolve) => window.setTimeout(resolve, 10))
        const now = performance.now()
        maxRendererTimerDriftMs = Math.max(maxRendererTimerDriftMs, now - expectedTimerAt)
        const ipcStartedAt = performance.now()
        await Promise.race([
          window.api.repos.list(),
          new Promise((_, reject) =>
            window.setTimeout(() => reject(new Error('repos:list IPC timed out')), ipcTimeoutMs)
          )
        ])
        ipcSamplesMs.push(performance.now() - ipcStartedAt)
        // Why re-read the clock here: anchoring on `now` would fold the IPC round trip that
        // ipcSamplesMs already records into the next iteration's drift.
        expectedTimerAt = performance.now() + 10
      }
      const result = await deletion
      if (failure) {
        throw new Error(`removeWorktree rejected: ${String(failure)}`)
      }
      const postDeleteIpcStartedAt = performance.now()
      await window.api.repos.list()
      const finalState = store.getState()
      return {
        result,
        totalMs: performance.now() - startedAt,
        ipcSamplesMs,
        postDeleteIpcMs: performance.now() - postDeleteIpcStartedAt,
        maxRendererTimerDriftMs,
        worktreeStillInStore: Object.values(finalState.worktreesByRepo)
          .flat()
          .some((worktree) => worktree.id === targetId),
        residualTabCount: finalState.tabsByWorktree[targetId]?.length ?? 0,
        residualBrowserTabCount: finalState.browserTabsByWorktree[targetId]?.length ?? 0,
        residualOpenFileCount: finalState.openFiles.filter((file) => file.worktreeId === targetId)
          .length
      }
    },
    { targetId: worktreeId, fallbackId: rootWorktreeId, ipcTimeoutMs: IPC_TIMEOUT_MS }
  )
}

async function verifyDeletion(page, worktree, historyPath, measurement) {
  if (!measurement.result?.ok) {
    throw new Error(`removeWorktree failed: ${measurement.result?.error ?? 'unknown error'}`)
  }
  if (measurement.worktreeStillInStore) {
    throw new Error('Deleted worktree remains in the renderer store')
  }
  if (
    measurement.residualTabCount ||
    measurement.residualBrowserTabCount ||
    measurement.residualOpenFileCount
  ) {
    throw new Error(
      `Deleted worktree retained UI state: ${JSON.stringify({
        tabs: measurement.residualTabCount,
        browserTabs: measurement.residualBrowserTabCount,
        openFiles: measurement.residualOpenFileCount
      })}`
    )
  }
  if (existsSync(worktree.path)) {
    throw new Error(`Deleted worktree directory remains at ${worktree.path}`)
  }
  if (existsSync(historyPath)) {
    throw new Error(`Live terminal history remains at ${historyPath}`)
  }
  await page.waitForFunction(
    (id) =>
      ![...document.querySelectorAll('[data-worktree-id]')].some(
        (element) => element.getAttribute('data-worktree-id') === id
      ),
    worktree.id
  )
}

async function runIteration(page, fixture, repoState, iteration, historyFiles) {
  const worktree = await createMeasuredWorktree(page, repoState.repoId, iteration)
  await assertWorktreeRowVisible(page, worktree.id)
  branchFixture.seedBranchCleanupRepro(fixture.repoPath, worktree.path)
  const historyPath = seedTerminalHistory(fixture.userDataPath, worktree.id, historyFiles)
  const measurement = await measureDeletion(page, worktree.id, repoState.rootWorktreeId)
  await verifyDeletion(page, worktree, historyPath, measurement)
  return {
    iteration,
    totalMs: round(measurement.totalMs),
    ipcLatencyMs: summarize(measurement.ipcSamplesMs),
    postDeleteIpcMs: round(measurement.postDeleteIpcMs),
    maxRendererTimerDriftMs: round(measurement.maxRendererTimerDriftMs)
  }
}

async function verifyRestart(instanceConfig, fixture, port, repoId) {
  const relaunched = launchDevInstance(instanceConfig, fixture, port)
  let browser = null
  try {
    const connection = await connectToOrca(relaunched)
    browser = connection.browser
    const { page } = connection
    const state = await page.evaluate(async (fixtureRepoId) => {
      const store = window.__store
      if (!store) {
        throw new Error('window.__store is unavailable after restart')
      }
      await window.api.repos.list()
      let recovery = { repoPresent: false, worktreeCount: 0 }
      for (let attempt = 0; attempt < 60; attempt += 1) {
        await store.getState().fetchRepos()
        if (store.getState().repos.some((repo) => repo.id === fixtureRepoId)) {
          await store.getState().fetchWorktrees(fixtureRepoId)
        }
        await new Promise((resolve) => window.setTimeout(resolve, 250))
        recovery = {
          repoPresent: store.getState().repos.some((repo) => repo.id === fixtureRepoId),
          worktreeCount: store.getState().worktreesByRepo[fixtureRepoId]?.length ?? 0
        }
        if (recovery.repoPresent && recovery.worktreeCount > 0) {
          break
        }
      }
      return recovery
    }, repoId)
    if (!state.repoPresent || state.worktreeCount < 1) {
      throw new Error(`Fixture repo did not recover after restart: ${JSON.stringify(state)}`)
    }
    await page.evaluate(async (fixtureRepoId) => {
      await window.__store?.getState().removeProject(fixtureRepoId)
    }, repoId)
  } finally {
    await browser?.close().catch(() => undefined)
    await stopDevInstance(relaunched)
  }
}

async function benchmarkInstance(instanceConfig, index, options) {
  run(
    process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm',
    ['run', 'ensure:electron-runtime'],
    instanceConfig.repoRoot
  )
  const fixture = createFixture(instanceConfig.label)
  let delayedFetchServer, instance, browser
  try {
    delayedFetchServer = await branchFixture.startDelayedFetchServer(options.fetchDelayMs)
    run('git', ['remote', 'set-url', 'origin', delayedFetchServer.url], fixture.repoPath)
    const port = await findAvailablePort(CDP_START_PORT + index)
    instance = launchDevInstance(instanceConfig, fixture, port)
    const { browser: connectedBrowser, page } = await connectToOrca(instance)
    browser = connectedBrowser
    const repoState = await addFixtureRepo(page, fixture.repoPath)
    const iterations = []
    for (let iteration = 1; iteration <= options.iterations; iteration += 1) {
      const result = await runIteration(page, fixture, repoState, iteration, options.historyFiles)
      iterations.push(result)
      console.log(
        `[${instanceConfig.label}] ${iteration}/${options.iterations}: ${result.totalMs}ms total, ` +
          `${result.ipcLatencyMs.max}ms max main IPC`
      )
    }
    await browser.close()
    browser = null
    await stopDevInstance(instance)
    // Why a fresh port: the debug listener may still hold the old one, so reusing it can attach to
    // the dying endpoint or burn the whole start timeout.
    await verifyRestart(
      instanceConfig,
      fixture,
      await findAvailablePort(port + 1),
      repoState.repoId
    )
    return {
      label: instanceConfig.label,
      repoRoot: instanceConfig.repoRoot,
      historyFiles: options.historyFiles,
      fetchDelayMs: options.fetchDelayMs,
      iterations,
      summary: summarize(iterations.map((entry) => entry.totalMs)),
      ipcSummary: summarize(iterations.flatMap((entry) => entry.ipcLatencyMs.samples)),
      restartPassed: true,
      fixtureRoot: options.keepFixture ? fixture.root : undefined
    }
  } finally {
    await browser?.close().catch(() => undefined)
    if (instance) {
      await stopDevInstance(instance)
    }
    await delayedFetchServer?.close()
    if (!options.keepFixture) {
      await rm(fixture.root, {
        recursive: true,
        force: true,
        maxRetries: 10,
        retryDelay: 250
      })
    }
  }
}

async function findAvailablePort(startPort) {
  for (let port = startPort; port < startPort + 100; port += 1) {
    if (await isPortAvailable(port)) {
      return port
    }
  }
  throw new Error(`No free CDP port found in ${startPort}-${startPort + 99}`)
}

function isPortAvailable(port) {
  return new Promise((resolve) => {
    const server = net.createServer()
    server.once('error', () => resolve(false))
    server.once('listening', () => server.close(() => resolve(true)))
    server.listen(port, '127.0.0.1')
  })
}

async function stopDevInstance(instance) {
  // Why signalCode too: a signal-terminated child leaves exitCode null, so an exitCode-only guard
  // re-enters the kill path for a dead process and burns the full 8s race on every teardown.
  if (instance.child.exitCode !== null || instance.child.signalCode !== null) {
    return
  }
  if (process.platform === 'win32') {
    spawnSync('taskkill.exe', ['/PID', String(instance.child.pid), '/T', '/F'], { stdio: 'ignore' })
    return
  }
  killDevInstanceTree(instance.child, 'SIGINT')
  const exited = await Promise.race([
    new Promise((resolve) => instance.child.once('exit', () => resolve(true))),
    delay(8_000).then(() => false)
  ])
  if (!exited) {
    killDevInstanceTree(instance.child, 'SIGKILL')
  }
}

/** POSIX: signal the whole group, or the launcher's Electron/Vite grandchildren survive and keep the
 *  CDP port and fixture directory busy. */
function killDevInstanceTree(child, signal) {
  try {
    process.kill(-child.pid, signal)
  } catch {
    child.kill(signal)
  }
}

function summarize(values) {
  const samples = values.map((value) => round(value)).sort((a, b) => a - b)
  if (samples.length === 0) {
    return { count: 0, median: 0, p95: 0, max: 0, samples }
  }
  return {
    count: samples.length,
    median: percentile(samples, 0.5),
    p95: percentile(samples, 0.95),
    max: samples.at(-1),
    samples
  }
}

function percentile(sorted, fraction) {
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)]
}

function round(value) {
  return Math.round(value * 100) / 100
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function printComparison(results) {
  console.log('\nWorktree deletion results')
  console.table(
    results.map((result) => ({
      instance: result.label,
      'delete median ms': result.summary.median,
      'delete p95 ms': result.summary.p95,
      'main IPC p95 ms': result.ipcSummary.p95,
      'main IPC max ms': result.ipcSummary.max,
      restart: result.restartPassed ? 'pass' : 'fail'
    }))
  )
  if (results.length === 2) {
    const [baseline, candidate] = results
    const percent = round(
      ((baseline.summary.median - candidate.summary.median) / baseline.summary.median) * 100
    )
    console.log(
      `${candidate.label} median deletion is ${Math.abs(percent)}% ${
        percent >= 0 ? 'faster' : 'slower'
      } than ${baseline.label}.`
    )
  }
}

const options = parseArgs(process.argv)
mkdirSync(resultsRoot, { recursive: true })
const results = []
for (const [index, instance] of options.instances.entries()) {
  results.push(await benchmarkInstance(instance, index, options))
}
const artifact = {
  benchmark: 'worktree-deletion-dev',
  createdAt: new Date().toISOString(),
  platform: process.platform,
  arch: process.arch,
  results
}
const artifactPath = path.join(
  resultsRoot,
  `worktree-deletion-${new Date().toISOString().replaceAll(/[:.]/g, '-')}.json`
)
writeFileSync(artifactPath, `${JSON.stringify(artifact, null, 2)}\n`)
printComparison(results)
console.log(`Artifact: ${artifactPath}`)
