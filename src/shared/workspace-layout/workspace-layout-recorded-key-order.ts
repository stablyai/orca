import type { WorkspaceSessionState } from '../workspace-session-state-types'

export function compareRecordedKeys(left: string, right: string): number {
  for (let i = 0; i < Math.min(left.length, right.length); i++) {
    const difference = left.charCodeAt(i) - right.charCodeAt(i)
    if (difference !== 0) {
      return difference
    }
  }
  return left.length - right.length
}

export function sortRecordedKeys(keys: string[]): string[] {
  let output = keys.slice()
  for (let width = 1; width < keys.length; width *= 2) {
    for (let start = 0; start < keys.length; start += width * 2) {
      const middle = Math.min(start + width, keys.length)
      const end = Math.min(start + width * 2, keys.length)
      let left = start
      let right = middle
      for (let next = start; next < end; next++) {
        output[next] =
          left < middle && (right >= end || compareRecordedKeys(keys[left], keys[right]) <= 0)
            ? keys[left++]
            : keys[right++]
      }
    }
    const previous = keys
    keys = output
    output = previous
  }
  return keys
}

/** A pane key's leaf for this tab, from the records that name one (the old window's leaf). */
export function createRecordedLeafReader(session: WorkspaceSessionState) {
  let keys: string[] | undefined
  return (tabId: string): string | undefined => {
    if (!keys) {
      const distinct = new Set<string>()
      for (const records of [
        session.terminalPtyIncarnationsByPaneKey,
        session.sleepingAgentSessionsByPaneKey,
        session.terminalSurfaceTombstonesByPaneKey
      ]) {
        for (const paneKey of Object.keys(records ?? {})) {
          distinct.add(paneKey)
        }
      }
      keys = sortRecordedKeys([...distinct])
    }
    const prefix = `${tabId}:`
    let low = 0
    let high = keys.length
    while (low < high) {
      const middle = low + Math.floor((high - low) / 2)
      if (compareRecordedKeys(keys[middle], prefix) < 0) {
        low = middle + 1
      } else {
        high = middle
      }
    }
    const first = keys[low]
    return first?.startsWith(prefix) && !keys[low + 1]?.startsWith(prefix)
      ? first.slice(prefix.length)
      : undefined
  }
}
