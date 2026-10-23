import { focusTerminalTabSurface } from '@/lib/focus-terminal-tab-surface'
import type { AppState } from '@/store/types'
import { runtimeEnvironmentIdOrLocalUnlessTwin } from '@/lib/worktree-runtime-owner'
import type { Tab } from '../../../shared/tab-types'
import { activateWebRuntimeSessionTab } from '@/runtime/web-runtime-session-tab-lifecycle'
import { isWebRuntimeSessionActive } from '@/runtime/web-runtime-session-environment'

export type ActivateWorkspaceTabStore = Pick<
  AppState,
  | 'activateTab'
  | 'focusGroup'
  | 'repos'
  | 'setActiveBrowserTab'
  | 'setActiveFile'
  | 'setActiveTab'
  | 'setActiveTabType'
  | 'settings'
  | 'worktreesByRepo'
>

/** Makes `target` the visible tab of its group and the workspace's active content of its type. */
export function activateWorkspaceTab(store: ActivateWorkspaceTabStore, target: Tab): boolean {
  const worktreeId = target.worktreeId
  const runtimeEnvironmentId = runtimeEnvironmentIdOrLocalUnlessTwin(store, worktreeId)
  store.focusGroup(worktreeId, target.groupId)
  store.activateTab(target.id)

  if (target.contentType === 'terminal') {
    if (isWebRuntimeSessionActive(runtimeEnvironmentId)) {
      void activateWebRuntimeSessionTab({
        worktreeId,
        tabId: target.entityId,
        environmentId: runtimeEnvironmentId
      })
    }
    store.setActiveTab(target.entityId)
    store.setActiveTabType('terminal', worktreeId)
    focusTerminalTabSurface(target.entityId)
    return true
  }

  if (target.contentType === 'browser') {
    if (isWebRuntimeSessionActive(runtimeEnvironmentId)) {
      void activateWebRuntimeSessionTab({
        worktreeId,
        tabId: target.id,
        environmentId: runtimeEnvironmentId
      })
    }
    store.setActiveBrowserTab(target.entityId)
    store.setActiveTabType('browser', worktreeId)
    return true
  }

  if (target.contentType === 'simulator') {
    store.setActiveTab(target.id)
    store.setActiveTabType('simulator', worktreeId)
    return true
  }

  store.setActiveFile(target.entityId)
  store.setActiveTabType('editor', worktreeId)
  return true
}
