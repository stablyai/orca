import { getRuntimeEnvironmentIdForWorktree } from '@/lib/worktree-runtime-owner'
import {
  activateWebRuntimeSessionTab,
  isWebRuntimeSessionActive
} from '@/runtime/web-runtime-session'
import { useAppStore } from '@/store'

export function activateCanvasTerminal({
  worktreeId,
  groupId,
  unifiedTabId,
  terminalTabId
}: {
  worktreeId: string
  groupId: string
  unifiedTabId: string
  terminalTabId: string
}): void {
  const store = useAppStore.getState()
  store.focusGroup(worktreeId, groupId)
  store.activateTab(unifiedTabId)

  const runtimeEnvironmentId = getRuntimeEnvironmentIdForWorktree(store, worktreeId)
  if (isWebRuntimeSessionActive(runtimeEnvironmentId)) {
    void activateWebRuntimeSessionTab({
      worktreeId,
      tabId: terminalTabId,
      environmentId: runtimeEnvironmentId
    })
  }

  store.setActiveTab(terminalTabId)
  store.setActiveTabType('terminal')
}
