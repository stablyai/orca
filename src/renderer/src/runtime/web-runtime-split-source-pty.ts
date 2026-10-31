import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { isWebTerminalSurfaceTabId } from '../../../shared/terminal-surface-id'
import { parseRemoteRuntimePtyId } from '../../../shared/remote-runtime/remote-runtime-pty-id'
import { runtimeEnvironmentIdUnlessTwin } from '../lib/resolve-owner'
import { useAppStore } from '../store'
import type { WebRuntimeSplitSource } from './web-runtime-split-focus'

/** Use published pane coordinates before attach only when the binding names this workspace’s server. */
export function readHostPublishedSplitSourcePtyId(source: WebRuntimeSplitSource): string | null {
  if (!isWebTerminalSurfaceTabId(source.tabId)) {
    return null
  }
  const state = useAppStore.getState()
  const ptyId = state.terminalLayoutsByTabId[source.tabId]?.ptyIdsByLeafId?.[source.leafId]
  const environmentId = runtimeEnvironmentIdUnlessTwin(state, source.worktreeId)
  return ptyId && environmentId && parseRemoteRuntimePtyId(ptyId)?.environmentId === environmentId
    ? ptyId
    : null
}

/** A pane of a paired server's tab: only that server starts terminals in it. */
export function isHostTabPane(source: WebRuntimeSplitSource): boolean {
  return (
    isWebTerminalSurfaceTabId(source.tabId) &&
    runtimeEnvironmentIdUnlessTwin(useAppStore.getState(), source.worktreeId) !== null
  )
}

/** Only the owning server starts panes in its tabs; local fallback would leave a blank split. */
export function notifyHostTabSplitRefused(source: WebRuntimeSplitSource): void {
  const state = useAppStore.getState()
  const environmentId = runtimeEnvironmentIdUnlessTwin(state, source.worktreeId)
  const disconnected =
    !environmentId ||
    state.runtimeStatusByEnvironmentId.get(environmentId)?.snapshot?.transport === 'disconnected'
  toast.error(
    disconnected
      ? translate(
          'auto.runtime.webRuntimeSession.remoteHostDisconnected',
          'The workspace is not connected to a remote Orca host.'
        )
      : translate(
          'auto.runtime.webRuntimeSession.splitSourceUnpublished',
          'The pane didn’t split: its terminal hasn’t started on the host yet.'
        ),
    // Why an id: repeated presses must not stack toasts.
    { id: 'web-runtime-host-tab-split-refused' }
  )
}
