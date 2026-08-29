import path from 'node:path'
import { classifyProcessStart } from './consumer-classifier.mjs'

const OBSERVER_DISCOVERY_MAX_DELAY_MS = 5_000

export function exactStartsForWindow(rows, rootPids, startMs, endMs) {
  return attemptedStartsForWindow(rows, rootPids, startMs, endMs).filter((row) =>
    Number.isInteger(row.returnedPid)
  )
}

export function attemptedStartsForWindow(rows, rootPids, startMs, endMs) {
  return rows
    .filter(
      (row) =>
        String(row.type).startsWith('spawn') &&
        rootPids.has(row.parentPid) &&
        Date.parse(row.timestamp) >= startMs &&
        Date.parse(row.timestamp) <= endMs
    )
    .map((row) => {
      const commandLine = row.argv.join(' ')
      const name = path.basename(row.executable ?? '')
      return {
        ...row,
        name,
        commandLine,
        consumer: classifyProcessStart({ name, commandLine })
      }
    })
}

export function correlateObserverStarts(observerStarts, exactStarts) {
  const exactMatches = new Set()
  const unmatchedObserverStarts = observerStarts.filter((observed) => {
    const observedAt = Date.parse(observed.timestamp)
    const matchIndex = exactStarts.findIndex((exact, index) => {
      if (exactMatches.has(index) || exact.returnedPid !== observed.pid) {
        return false
      }
      const discoveryDelayMs = observedAt - Date.parse(exact.timestamp)
      return discoveryDelayMs >= 0 && discoveryDelayMs <= OBSERVER_DISCOVERY_MAX_DELAY_MS
    })
    if (matchIndex === -1) {
      return true
    }
    exactMatches.add(matchIndex)
    return false
  })
  const unobservedExactStarts = exactStarts.filter((_, index) => !exactMatches.has(index))
  return {
    complete: unmatchedObserverStarts.length === 0,
    matchedStartCount: exactMatches.size,
    unmatchedObserverStarts,
    // Expected for children shorter than the observer's polling interval.
    unobservedExactStarts
  }
}
