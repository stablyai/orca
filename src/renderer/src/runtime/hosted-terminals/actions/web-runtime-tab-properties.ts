import type { RuntimeRpcResponse } from '../../../../../shared/runtime-rpc-envelope'
import { runtimeEnvironmentIdUnlessTwin } from '../../../lib/resolve-owner'
import { useAppStore } from '../../../store/index'
import { unwrapRuntimeRpcResult } from '../../rpc/calls/runtime-rpc-result'
import { toRuntimeWorktreeSelector } from '../../rpc/targets/runtime-worktree-selector'
import {
  isWebTerminalSurfaceTabId,
  toHostSessionTabId
} from '../../../../../shared/workspace-layout/terminal-surface-id'
import {
  captureRuntimeEnvironmentCall,
  isWebRuntimeSessionActive
} from '../../web-session-tabs-sync/identity/web-runtime-session-environment'

// Push color/pin to the authoritative host for persistence; undefined means unchanged.
export function setWebRuntimeTabProps(args: {
  worktreeId: string
  tabId: string
  color?: string | null
  isPinned?: boolean
  viewMode?: 'terminal' | 'chat'
  customTitle?: string | null
}): boolean {
  const environmentId = runtimeEnvironmentIdUnlessTwin(
    useAppStore.getState(),
    args.worktreeId,
    'push tab props to its host'
  )
  if (!environmentId || !isWebRuntimeSessionActive(environmentId)) {
    return false
  }
  const callEnvironment = captureRuntimeEnvironmentCall(environmentId)
  const state = useAppStore.getState()
  void import('../../web-session-tabs-sync/tracking-mappings')
    .then(({ resolveHostSessionTabIdForWebSessionTab }) => {
      const hostTabId =
        resolveHostSessionTabIdForWebSessionTab(state, {
          environmentId,
          worktreeId: args.worktreeId,
          tabId: args.tabId
        }) ?? (isWebTerminalSurfaceTabId(args.tabId) ? toHostSessionTabId(args.tabId) : args.tabId)
      return callEnvironment({
        method: 'session.tabs.setTabProps',
        params: {
          worktree: toRuntimeWorktreeSelector(args.worktreeId),
          tabId: hostTabId,
          ...(args.color !== undefined ? { color: args.color } : {}),
          ...(args.isPinned !== undefined ? { isPinned: args.isPinned } : {}),
          ...(args.viewMode !== undefined ? { viewMode: args.viewMode } : {}),
          ...(args.customTitle !== undefined ? { customTitle: args.customTitle } : {})
        },
        timeoutMs: 15_000
      })
    })
    .then((response) => {
      unwrapRuntimeRpcResult(response as RuntimeRpcResponse<{ updated: true }>)
    })
    .catch((error) => {
      console.warn(
        '[web-runtime-session] failed to set tab props:',
        error instanceof Error ? error.message : String(error)
      )
    })
  return true
}
