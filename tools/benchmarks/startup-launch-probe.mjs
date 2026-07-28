/**
 * One instrumented Orca launch: spawn, parse `ORCA_STARTUP_DIAGNOSTICS=1`
 * milestone lines off stderr, and derive per-phase timings.
 *
 * Shared by the single-arm benchmark and the interleaved A/B benchmark so both
 * report phases computed by identical code — otherwise their numbers could not
 * be compared against each other.
 */
import { spawn, spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'

const repoRoot = resolve(import.meta.dirname, '..', '..')
const require = createRequire(import.meta.url)

function killProcessTree(proc) {
  if (proc.exitCode !== null || proc.signalCode !== null) {
    return
  }
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { stdio: 'ignore' })
  } else {
    try {
      proc.kill('SIGKILL')
    } catch {
      // already gone
    }
  }
}

export function parseStartupLine(line) {
  // Why: the main-thread churn probe (ORCA_MAIN_THREAD_DIAGNOSTICS=1) emits a
  // different prefix with a JSON payload. Its per-command spawn attribution
  // (spawns[cmd].blockMsTotal) is the only signal that names which binary held
  // the main thread, so capture it here instead of dropping the line.
  const mainThreadMatch = /^\[main-thread\] (\{.*\})$/.exec(line)
  if (mainThreadMatch) {
    try {
      return { event: 'main-thread', details: JSON.parse(mainThreadMatch[1]) }
    } catch {
      return null
    }
  }
  const match = /^\[startup\] (\S+)(.*)$/.exec(line)
  if (!match) {
    return null
  }
  const details = {}
  const detailText = match[2].trim()
  if (detailText) {
    for (const pair of detailText.match(/(\S+?)=("[^"]*"|\S+)/g) ?? []) {
      const eq = pair.indexOf('=')
      const key = pair.slice(0, eq)
      let value = pair.slice(eq + 1)
      try {
        value = JSON.parse(value)
      } catch {
        // keep raw string
      }
      details[key] = value
    }
  }
  return { event: match[1], details }
}

/**
 * `exe` runs a packaged build; otherwise the npm `electron` binary loads
 * `appDir` (the repo's own `out/` unless an arm supplies its own tree).
 */
export function runIteration({ exe, appDir, timeoutMs, lingerMs, waitForEvent, launchEnv }) {
  return new Promise((resolvePromise) => {
    // Why: npm's `electron` package exposes the platform-specific executable;
    // hardcoding electron.exe made this benchmark unusable on macOS/Linux.
    const command = exe ?? require('electron')
    const commandArgs = exe ? [] : [appDir ?? repoRoot]
    const events = []
    const startedAt = process.hrtime.bigint()
    const child = spawn(command, commandArgs, {
      env: launchEnv,
      stdio: ['ignore', 'ignore', 'pipe']
    })
    let finished = false
    let buffer = ''
    const finish = (outcome) => {
      if (finished) {
        return
      }
      finished = true
      clearTimeout(timer)
      // Keep the app alive briefly so trailing diagnostic lines (and, with
      // --linger-ms raised, background work like the async ACL grant) finish.
      setTimeout(() => {
        killProcessTree(child)
        resolvePromise({ outcome, events })
      }, lingerMs)
    }
    const timer = setTimeout(() => finish('timeout'), timeoutMs)
    child.stderr.setEncoding('utf-8')
    child.stderr.on('data', (chunk) => {
      buffer += chunk
      let newlineIndex = buffer.indexOf('\n')
      while (newlineIndex !== -1) {
        const line = buffer.slice(0, newlineIndex).trimEnd()
        buffer = buffer.slice(newlineIndex + 1)
        newlineIndex = buffer.indexOf('\n')
        const parsed = parseStartupLine(line)
        if (!parsed) {
          continue
        }
        const harnessMs = Number(process.hrtime.bigint() - startedAt) / 1e6
        events.push({ ...parsed, harnessMs: Math.round(harnessMs * 10) / 10 })
        if (parsed.event === waitForEvent) {
          finish('ok')
        }
      }
    })
    child.on('exit', () => finish('early-exit'))
    child.on('error', () => finish('spawn-error'))
  })
}

function eventTime(events, name, key) {
  const entry = events.find((event) => event.event === name)
  if (!entry) {
    return null
  }
  return key === 't'
    ? typeof entry.details.t === 'number'
      ? entry.details.t
      : null
    : entry.harnessMs
}

function delta(events, from, to) {
  const a = eventTime(events, from, 't')
  const b = eventTime(events, to, 't')
  return a !== null && b !== null ? b - a : null
}

function maxEventDetailsNumber(events, name, key) {
  let max = null
  for (const event of events) {
    if (event.event !== name) {
      continue
    }
    const value = event.details[key]
    if (typeof value === 'number' && (max === null || value > max)) {
      max = value
    }
  }
  return max
}

function eventDetailsNumber(events, name, key) {
  const value = events.find((event) => event.event === name)?.details[key]
  return typeof value === 'number' ? value : null
}

export function derivePhases(events) {
  const aclStart = eventTime(events, 'acl-grant-start', 't')
  const aclDone = eventTime(events, 'acl-grant-done', 't')
  return {
    startupJsonParseMs: delta(
      events,
      'persistence-json-parse-start',
      'persistence-json-parse-done'
    ),
    startupStoreLoadMs: delta(events, 'persistence-load-start', 'persistence-load-done'),
    spawnToAppReady: eventTime(events, 'app-ready', 'harness'),
    appReadyToServices: delta(events, 'app-ready', 'services-initialized'),
    servicesToI18n: delta(events, 'services-initialized', 'i18n-ready'),
    i18nToOpenWindow: delta(events, 'i18n-ready', 'open-main-window-start'),
    daemonInitMs: delta(events, 'daemon-init-start', 'daemon-init-done'),
    aclGrantMs: aclStart !== null && aclDone !== null ? aclDone - aclStart : null,
    windowCreatedToLoadStart: delta(events, 'window-created', 'load-start'),
    windowCreatedToLoaded: delta(events, 'window-created', 'did-finish-load'),
    totalToWindowCreated: eventTime(events, 'window-created', 'harness'),
    totalToDidFinishLoad: eventTime(events, 'did-finish-load', 'harness'),
    didFinishLoadToWorkspaceReady: delta(
      events,
      'did-finish-load',
      'renderer-startup-hydration-done'
    ),
    totalToWorkspaceReady: eventTime(events, 'renderer-startup-hydration-done', 'harness'),
    rendererReconnectTerminalsMs:
      eventDetailsNumber(events, 'renderer-reconnect-terminals-done', 'durationMs') ??
      delta(
        events,
        'renderer-first-window-services-await-done',
        'renderer-reconnect-terminals-done'
      ),
    // Worst single main-thread stall observed by the event-loop probe — the
    // direct measurement of issue #7225's "Not Responding" freeze.
    maxEventLoopStallMs: maxEventDetailsNumber(events, 'event-loop-stall', 'maxGapMs')
  }
}
