import type { Tab } from '../../../../shared/tab-types'
import { useAppStore } from '../../store'
import { focusTerminalTabSurface } from '../../lib/focus-terminal-tab-surface'
import { activateWebRuntimeSessionTab } from '../../runtime/web-runtime-session-tab-lifecycle'
import { isWebRuntimeSessionActive } from '../../runtime/web-runtime-session-environment'
import { runtimeEnvironmentIdOrLocalUnlessTwin } from '@/lib/worktree-runtime-owner'
import { browserWorkspaceHasRemoteOwner } from '@/runtime/remote-browser-tab-ownership'
import { activateStructuredAgentSessionTab } from '@/lib/agent-session/structured-agent-session-tab-activation'
import { requestBrowserFocus } from '@/components/browser-pane/host-guest/browser-focus'

export function activateTabGroupTab(
  worktreeId: string,
  item: Tab,
  options: {
    focusBrowser?: boolean
    activeLeafId?: string | null
    onlyIfFocusUnclaimed?: boolean
  } = {}
): void {
  if (item.contentType === 'agent-session') {
    activateStructuredAgentSessionTab({ worktreeId, tabId: item.id })
    return
  }
  const state = useAppStore.getState()
  state.focusGroup(worktreeId, item.groupId)
  state.activateTab(item.id)
  if (item.contentType === 'terminal' || item.contentType === 'browser') {
    const environmentId = runtimeEnvironmentIdOrLocalUnlessTwin(state, worktreeId)
    if (
      isWebRuntimeSessionActive(environmentId) &&
      (item.contentType === 'terminal' ||
        browserWorkspaceHasRemoteOwner(state, item.entityId, environmentId))
    ) {
      void activateWebRuntimeSessionTab({
        worktreeId,
        tabId: item.contentType === 'terminal' ? item.entityId : item.id,
        environmentId
      })
    }
    if (item.contentType === 'terminal') {
      state.setActiveTab(item.entityId)
      state.setActiveTabType('terminal', worktreeId)
      const activeLeafId =
        options.activeLeafId ?? state.terminalLayoutsByTabId?.[item.entityId]?.activeLeafId ?? null
      if (options.onlyIfFocusUnclaimed) {
        focusTerminalTabSurface(item.entityId, activeLeafId, { onlyIfFocusUnclaimed: true })
      } else {
        focusTerminalTabSurface(item.entityId, activeLeafId)
      }
    } else {
      state.setActiveBrowserTab(item.entityId, worktreeId)
      state.setActiveTabType('browser', worktreeId)
      const workspace = (state.browserTabsByWorktree[worktreeId] ?? []).find(
        (candidate) => candidate.id === item.entityId
      )
      if (options.focusBrowser && workspace?.activePageId) {
        requestBrowserFocus({ pageId: workspace.activePageId, target: 'webview' })
      }
    }
    return
  }
  if (item.contentType === 'simulator') {
    state.setActiveTabType('simulator', worktreeId)
  } else {
    state.setActiveFile(item.entityId, worktreeId)
    state.setActiveTabType('editor', worktreeId)
  }
}
