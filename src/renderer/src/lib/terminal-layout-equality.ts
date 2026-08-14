import type { TerminalLayoutSnapshot, TerminalPaneLayoutNode } from '../../../shared/types'

function sameStringRecord(
  a: Readonly<Record<string, string>> | undefined,
  b: Readonly<Record<string, string>> | undefined
): boolean {
  const left = a ?? {}
  const right = b ?? {}
  const leftKeys = Object.keys(left)
  const rightKeys = Object.keys(right)
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every((key) => Object.hasOwn(right, key) && left[key] === right[key])
  )
}

export function terminalLayoutNodeEqual(
  a: TerminalPaneLayoutNode | null | undefined,
  b: TerminalPaneLayoutNode | null | undefined
): boolean {
  if (!a || !b) {
    return !a && !b
  }
  if (a.type !== b.type) {
    return false
  }
  if (a.type === 'leaf') {
    return b.type === 'leaf' && a.leafId === b.leafId
  }
  return (
    b.type === 'split' &&
    a.direction === b.direction &&
    a.ratio === b.ratio &&
    terminalLayoutNodeEqual(a.first, b.first) &&
    terminalLayoutNodeEqual(a.second, b.second)
  )
}

/** Structural equality over every persisted layout field; drives store/IPC write bailouts. */
export function terminalLayoutEqual(
  a: TerminalLayoutSnapshot | undefined,
  b: TerminalLayoutSnapshot
): boolean {
  return (
    terminalLayoutNodeEqual(a?.root, b.root) &&
    (a?.activeLeafId ?? null) === b.activeLeafId &&
    (a?.expandedLeafId ?? null) === b.expandedLeafId &&
    sameStringRecord(a?.ptyIdsByLeafId, b.ptyIdsByLeafId) &&
    sameStringRecord(a?.buffersByLeafId, b.buffersByLeafId) &&
    sameStringRecord(a?.scrollbackRefsByLeafId, b.scrollbackRefsByLeafId) &&
    sameStringRecord(a?.titlesByLeafId, b.titlesByLeafId)
  )
}
