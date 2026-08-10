import type { AppState } from '../store/types'

type DirectSshTabProcessInputRefs = Pick<
  AppState,
  'lastKnownRelayPtyIdByTabId' | 'ptyIdsByTabId' | 'terminalLayoutsByTabId'
>

function directSshTabProcessInputRefs(state: AppState): DirectSshTabProcessInputRefs {
  return {
    lastKnownRelayPtyIdByTabId: state.lastKnownRelayPtyIdByTabId,
    ptyIdsByTabId: state.ptyIdsByTabId,
    terminalLayoutsByTabId: state.terminalLayoutsByTabId
  }
}

function directSshTabProcessInputRefsEqual(
  previous: DirectSshTabProcessInputRefs | null,
  next: DirectSshTabProcessInputRefs
): boolean {
  if (!previous) {
    return false
  }
  return (
    previous.lastKnownRelayPtyIdByTabId === next.lastKnownRelayPtyIdByTabId &&
    previous.ptyIdsByTabId === next.ptyIdsByTabId &&
    previous.terminalLayoutsByTabId === next.terminalLayoutsByTabId
  )
}

function directSshTargetByTab(
  state: AppState,
  targetByWorktree: ReadonlyMap<string, string>
): Map<string, string> {
  return new Map(
    Object.entries(state.tabsByWorktree).flatMap(([worktreeId, tabs]) => {
      const targetId = targetByWorktree.get(worktreeId)
      return targetId ? tabs.map((tab) => [tab.id, targetId] as const) : []
    })
  )
}

function addDirectSshProcessInputTargetIds(
  previous: DirectSshTabProcessInputRefs | null,
  next: DirectSshTabProcessInputRefs,
  previousTargetByTab: ReadonlyMap<string, string>,
  targetByTab: ReadonlyMap<string, string>,
  targets: Set<string>
): void {
  const addChangedOwners = <T>(
    before: Readonly<Record<string, T>>,
    after: Readonly<Record<string, T>>
  ): void => {
    if (before === after) {
      return
    }
    for (const tabId of new Set([...Object.keys(before), ...Object.keys(after)])) {
      if (before[tabId] !== after[tabId]) {
        const targetId = targetByTab.get(tabId) ?? previousTargetByTab.get(tabId)
        if (targetId) {
          targets.add(targetId)
        }
      }
    }
  }
  if (!previous) {
    return
  }
  addChangedOwners(previous.terminalLayoutsByTabId, next.terminalLayoutsByTabId)
  addChangedOwners(previous.ptyIdsByTabId, next.ptyIdsByTabId)
  addChangedOwners(previous.lastKnownRelayPtyIdByTabId, next.lastKnownRelayPtyIdByTabId)
}

export type DirectSshTabProcessInputTracker = {
  clear: () => void
  collectChanges: (args: {
    rebuildOwners: boolean
    state: AppState
    targetByWorktree: ReadonlyMap<string, string>
    targets: Set<string>
  }) => void
  inputsChanged: (state: AppState) => boolean
}

export function createDirectSshTabProcessInputTracker(): DirectSshTabProcessInputTracker {
  let previousInputs: DirectSshTabProcessInputRefs | null = null
  let targetByTab = new Map<string, string>()
  return {
    inputsChanged: (state) =>
      !directSshTabProcessInputRefsEqual(previousInputs, directSshTabProcessInputRefs(state)),
    collectChanges: ({ rebuildOwners, state, targetByWorktree, targets }) => {
      const nextInputs = directSshTabProcessInputRefs(state)
      const previousOwners = targetByTab
      if (rebuildOwners) {
        targetByTab = directSshTargetByTab(state, targetByWorktree)
      }
      addDirectSshProcessInputTargetIds(
        previousInputs,
        nextInputs,
        previousOwners,
        targetByTab,
        targets
      )
      previousInputs = nextInputs
    },
    clear: () => {
      previousInputs = null
      targetByTab.clear()
    }
  }
}
