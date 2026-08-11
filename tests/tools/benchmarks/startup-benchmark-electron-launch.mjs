import { spawn, spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { normalizeStartupBenchmarkOutcome } from './startup-benchmark-sample.mjs'

const require = createRequire(import.meta.url)
const GRACEFUL_SHUTDOWN_TIMEOUT_MS = 30_000

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

function requestGracefulShutdown(proc) {
  if (!proc.connected) {
    return false
  }
  try {
    // Why: Orca maps benchmark IPC disconnect to app.quit() on every platform.
    proc.disconnect()
    return true
  } catch {
    return false
  }
}

export function runElectronStartupBenchmarkIteration(options) {
  return new Promise((resolvePromise) => {
    const command = options.exe ?? require('electron')
    const commandArgs = options.exe ? [] : [options.appPath]
    const events = []
    const startedAt = process.hrtime.bigint()
    const child = spawn(command, commandArgs, {
      env: options.launchEnv,
      stdio: ['ignore', 'ignore', 'pipe', 'ipc']
    })
    let exitCode = null
    let exitSignal = null
    let finishOutcome = null
    let gracefulShutdownRequested = false
    let lingerTimer = null
    let settled = false
    let shutdownTimer = null
    let buffer = ''
    const settle = (outcome) => {
      if (settled) {
        return
      }
      settled = true
      clearTimeout(timer)
      clearTimeout(lingerTimer)
      clearTimeout(shutdownTimer)
      const result = { outcome, events, exitCode, exitSignal, gracefulShutdownRequested }
      result.outcome = normalizeStartupBenchmarkOutcome(result)
      resolvePromise(result)
    }
    const finish = (outcome) => {
      if (finishOutcome !== null) {
        return
      }
      finishOutcome = outcome
      clearTimeout(timer)
      if (outcome === 'early-exit' || outcome === 'spawn-error') {
        settle(outcome)
        return
      }
      lingerTimer = setTimeout(() => {
        if (child.exitCode !== null || child.signalCode !== null) {
          settle(outcome)
          return
        }
        gracefulShutdownRequested = requestGracefulShutdown(child)
        if (!gracefulShutdownRequested) {
          killProcessTree(child)
          settle('graceful-shutdown-unavailable')
          return
        }
        shutdownTimer = setTimeout(() => {
          killProcessTree(child)
          settle('graceful-shutdown-timeout')
        }, GRACEFUL_SHUTDOWN_TIMEOUT_MS)
      }, options.lingerMs)
    }
    const timer = setTimeout(() => finish('timeout'), options.timeoutMs)
    child.stderr.setEncoding('utf-8')
    child.stderr.on('data', (chunk) => {
      buffer += chunk
      let newlineIndex = buffer.indexOf('\n')
      while (newlineIndex !== -1) {
        const line = buffer.slice(0, newlineIndex).trimEnd()
        buffer = buffer.slice(newlineIndex + 1)
        newlineIndex = buffer.indexOf('\n')
        const parsed = options.parseStartupLine(line)
        if (!parsed) {
          continue
        }
        const harnessMs = Number(process.hrtime.bigint() - startedAt) / 1e6
        events.push({ ...parsed, harnessMs: Math.round(harnessMs * 10) / 10 })
        if (parsed.event === options.waitForEvent) {
          finish('ok')
        }
      }
    })
    child.on('exit', (code, signal) => {
      exitCode = code
      exitSignal = signal
      settle(finishOutcome ?? 'early-exit')
    })
    child.on('error', () => finish('spawn-error'))
  })
}
