import { existsSync, mkdirSync, readdirSync } from 'node:fs'

const READY_POLL_MS = 25

export function initializeOracleOutputDirectory(outputDir) {
  if (existsSync(outputDir)) {
    const entries = readdirSync(outputDir).sort()
    if (entries.length > 0) {
      throw new Error(
        `--output must be absent or empty; found stale artifacts: ${entries.join(', ')}`
      )
    }
  } else {
    mkdirSync(outputDir, { recursive: true })
  }
}

export function trackChildExit(child) {
  return new Promise((resolve) => {
    let settled = false
    const finish = (outcome) => {
      if (settled) {
        return
      }
      settled = true
      resolve(outcome)
    }
    child.once('error', (error) => finish({ type: 'error', error }))
    child.once('exit', (code, signal) => finish({ type: 'exit', code, signal }))
  })
}

export async function waitForObserverReady({ readyPath, exit, timeoutMs }) {
  const deadline = Date.now() + timeoutMs
  while (!existsSync(readyPath)) {
    const remainingMs = deadline - Date.now()
    if (remainingMs <= 0) {
      throw new Error(`native process observer did not become ready within ${timeoutMs}ms`)
    }
    const outcome = await Promise.race([
      exit,
      new Promise((resolve) =>
        setTimeout(() => resolve(null), Math.min(READY_POLL_MS, remainingMs))
      )
    ])
    if (outcome) {
      throw childExitError('native process observer exited before becoming ready', outcome)
    }
  }
}

export async function waitForSuccessfulChildExit(exit, label, timeoutMs) {
  const outcome = await waitForChildExit(exit, label, timeoutMs)
  if (outcome.type === 'error' || outcome.code !== 0) {
    throw childExitError(`${label} failed`, outcome)
  }
  return outcome
}

export async function waitForChildExit(exit, label, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error(`${label} did not exit within ${timeoutMs}ms`))
    }, timeoutMs)
    exit.then(
      (outcome) => {
        clearTimeout(timeout)
        resolve(outcome)
      },
      (error) => {
        clearTimeout(timeout)
        reject(error)
      }
    )
  })
}

function childExitError(prefix, outcome) {
  if (outcome.type === 'error') {
    return new Error(`${prefix}: ${outcome.error?.message ?? String(outcome.error)}`)
  }
  return new Error(`${prefix}: code ${outcome.code ?? 'null'}, signal ${outcome.signal ?? 'none'}`)
}
