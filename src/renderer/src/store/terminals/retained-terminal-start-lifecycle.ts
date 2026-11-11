import { collectLeafIds } from '../../../../shared/workspace-layout/terminal-pane-layout-tree'
import type { TerminalLayoutSnapshot } from '../../../../shared/workspace-layout/terminal-tab-types'
import type { TerminalPaneStart } from './terminal-state'
import type { RetainedTerminalStart } from '../../../../shared/workspace-layout/retained-terminal-start'

export function retainedStartSupersedes(
  previous: RetainedTerminalStart | undefined,
  next: RetainedTerminalStart
): boolean {
  if (!previous) {
    return true
  }
  if (
    previous.worktreeId !== next.worktreeId ||
    previous.executionHostId !== next.executionHostId
  ) {
    return false
  }
  return (
    previous.runtimeId !== next.runtimeId ||
    (previous.bindingGeneration <= next.bindingGeneration &&
      (previous.startSequence < next.startSequence ||
        (previous.startSequence === next.startSequence &&
          (previous.status === 'starting' ||
            previous.status === 'resuming' ||
            next.status === 'failed' ||
            next.status === 'held'))))
  )
}

/** Binding and explicit removal retire the mark in the same store publication. */
export function terminalStartsAfterLayout(
  starts: Record<string, TerminalPaneStart>,
  tabId: string,
  before: TerminalLayoutSnapshot | undefined,
  after: TerminalLayoutSnapshot | null,
  acceptedLeafId?: string
): Record<string, TerminalPaneStart> {
  const remaining = new Set(collectLeafIds(after?.root))
  let next = starts
  for (const leafId of collectLeafIds(before?.root)) {
    const key = `${tabId}:${leafId}`
    if (
      starts[key]?.retainedTerminalStart &&
      (!remaining.has(leafId) ||
        (after?.ptyIdsByLeafId?.[leafId] &&
          (acceptedLeafId === leafId ||
            after.ptyIdsByLeafId[leafId] !== before?.ptyIdsByLeafId?.[leafId])))
    ) {
      if (next === starts) {
        next = { ...starts }
      }
      delete next[key]
    }
  }
  return next
}
