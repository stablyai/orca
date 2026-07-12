import type { AppState } from '../../store'
import {
  buildResourceSessionBindingIndex,
  type ResourceSessionBindingIndex,
  type ResourceSessionBindingInputs
} from './resource-session-bindings'

export type ClosedResourceSessionCountState = Pick<
  AppState,
  'tabsByWorktree' | 'ptyIdsByTabId' | 'terminalLayoutsByTabId' | 'workspaceSessionReady'
>

type BuildResourceSessionBindingIndex = (
  inputs: ResourceSessionBindingInputs
) => ResourceSessionBindingIndex

export type ClosedResourceSessionCountSelector = (state: ClosedResourceSessionCountState) => number

function haveSameTabBindings(
  previous: AppState['tabsByWorktree'],
  next: AppState['tabsByWorktree']
): boolean {
  if (previous === next) {
    return true
  }

  const previousWorktreeIds = Object.keys(previous)
  const nextWorktreeIds = Object.keys(next)
  if (previousWorktreeIds.length !== nextWorktreeIds.length) {
    return false
  }

  for (const worktreeId of nextWorktreeIds) {
    const previousTabs = previous[worktreeId]
    const nextTabs = next[worktreeId]
    if (previousTabs === nextTabs) {
      continue
    }
    if (!previousTabs || previousTabs.length !== nextTabs.length) {
      return false
    }
    for (let index = 0; index < nextTabs.length; index += 1) {
      const previousTab = previousTabs[index]
      const nextTab = nextTabs[index]
      // Why: the closed badge counts PTY ownership only. Titles and other
      // display fields can churn per terminal frame without changing it.
      if (previousTab.id !== nextTab.id || previousTab.ptyId !== nextTab.ptyId) {
        return false
      }
    }
  }

  return true
}

export function createClosedResourceSessionCountSelector(
  buildBindingIndex: BuildResourceSessionBindingIndex = buildResourceSessionBindingIndex
): ClosedResourceSessionCountSelector {
  // Why: Zustand runs selectors for every store notification. Keep the last
  // liveness inputs here so unrelated and title-only writes stay scalar-cheap.
  let initialized = false
  let previousTabsByWorktree: AppState['tabsByWorktree'] = {}
  let previousPtyIdsByTabId: AppState['ptyIdsByTabId'] = {}
  let previousTerminalLayoutsByTabId: AppState['terminalLayoutsByTabId'] = {}
  let previousWorkspaceSessionReady = false
  let count = 0

  return (state): number => {
    const bindingMapChanged =
      state.ptyIdsByTabId !== previousPtyIdsByTabId ||
      state.terminalLayoutsByTabId !== previousTerminalLayoutsByTabId
    const readinessChanged = state.workspaceSessionReady !== previousWorkspaceSessionReady
    const tabsReferenceChanged = state.tabsByWorktree !== previousTabsByWorktree
    let tabBindingsChanged = tabsReferenceChanged
    if (
      initialized &&
      state.workspaceSessionReady &&
      !bindingMapChanged &&
      !readinessChanged &&
      tabsReferenceChanged
    ) {
      tabBindingsChanged = !haveSameTabBindings(previousTabsByWorktree, state.tabsByWorktree)
    }

    const shouldRebuild =
      state.workspaceSessionReady &&
      (!initialized || bindingMapChanged || readinessChanged || tabBindingsChanged)

    if (shouldRebuild) {
      count = buildBindingIndex(state).boundPtyIds.size
    } else if (!state.workspaceSessionReady) {
      count = 0
    }

    previousTabsByWorktree = state.tabsByWorktree
    previousPtyIdsByTabId = state.ptyIdsByTabId
    previousTerminalLayoutsByTabId = state.terminalLayoutsByTabId
    previousWorkspaceSessionReady = state.workspaceSessionReady
    initialized = true
    return count
  }
}
