import type { NotificationWorkspaceOwner } from '../../../../shared/notification-source'
import { makePaneKey } from '../../../../shared/stable-pane-id'
import { useAppStore } from '@/store'
import { isRemoteRuntimePtyId } from '../../../../shared/remote-runtime/remote-runtime-pty-id'
import { isRendererHiddenPtyDeliveryGateEnabled } from './terminal-hidden-delivery-gate'
import { acquireHiddenRendererPtyDeliveryClaim } from './pty-renderer-delivery-claims'
import { resolveTerminalResidentBinding } from './terminal-resident-binding'
import {
  followLocalTerminalSemanticSource,
  admitRemoteTerminalSemanticResident,
  isMainTerminalSideEffectAuthorityForPty,
  registerTerminalSideEffectFactConsumer
} from './terminal-side-effect-facts-handler'

export type ParkedTerminalByteWatcherOptions = {
  workspaceOwner?: NotificationWorkspaceOwner
  ptyId: string
  tabId: string
  worktreeId: string
  /** Stable leaf UUID combined with tabId for cache, unread and notification attribution. */
  leafId: string
  /** Reuse the unmounted pane’s numeric title slot so stale working status cannot strand. */
  paneId: number
  /** Whether this PTY's pane was the tab's active split — only the focused split drives the tab title. */
  drivesTabTitle?: boolean
  /** Seed working state so the recreated tracker recognizes completion after park. */
  initialTitle?: string
  /** Pull main's title-only snapshot when a watcher starts before its pane ever mounted (ordinary park cycles already have a title). */
  restoreTitleOnRegister?: boolean
}

const parkedWatcherDisposersByPtyId = new Map<string, () => void>()

/** Parking changes presentation, never the execution's input, proof or completion lifetime. */
export function startParkedTerminalByteWatcher(
  options: ParkedTerminalByteWatcherOptions
): () => void {
  const { ptyId, tabId, worktreeId, paneId } = options
  parkedWatcherDisposersByPtyId.get(ptyId)?.()
  const remote = isRemoteRuntimePtyId(ptyId)
  const paneKey = makePaneKey(tabId, options.leafId)
  const mainAuthority = isMainTerminalSideEffectAuthorityForPty({
    settings: useAppStore.getState().settings,
    runtimeEnvironmentId: remote ? 'remote' : null
  })
  const binding = resolveTerminalResidentBinding({
    ptyId,
    paneKey,
    tabId,
    worktreeId,
    binding: { initialTitle: options.initialTitle, workspaceOwner: options.workspaceOwner }
  })
  if (!remote) {
    followLocalTerminalSemanticSource({ ptyId, binding, byteSource: !mainAuthority })
  }
  if (remote) {
    void admitRemoteTerminalSemanticResident({ ptyId, binding, byteSource: true })
  }
  let wroteTitle = false
  const showTitle = (title: string) => {
    wroteTitle = true
    const state = useAppStore.getState()
    state.setRuntimePaneTitle(tabId, paneId, title)
    if (options.drivesTabTitle !== false) {
      state.updateTabTitle(tabId, title)
    }
  }
  const unregister = registerTerminalSideEffectFactConsumer({
    ptyId,
    binding,
    restoreTitleOnRegister: options.restoreTitleOnRegister === true,
    onResident: (resident) =>
      resident.policy.attachPresentation({
        paneId,
        isVisible: () => false,
        showTitle,
        resetInputModes: () => {},
        setFocusReportSuppression: () => {},
        clearFocusReportSuppression: () => {},
        markBracketedPasteInterrupted: () => {},
        onAgentExited: () => {},
        setMode2031: () => {}
      })
  })
  const releaseHidden =
    mainAuthority && isRendererHiddenPtyDeliveryGateEnabled(useAppStore.getState().settings)
      ? acquireHiddenRendererPtyDeliveryClaim(ptyId)
      : undefined
  let disposed = false
  const dispose = () => {
    if (disposed) {
      return
    }
    disposed = true
    releaseHidden?.()
    unregister()
    if (wroteTitle) {
      useAppStore.getState().clearRuntimePaneTitle(tabId, paneId)
    }
    if (parkedWatcherDisposersByPtyId.get(ptyId) === dispose) {
      parkedWatcherDisposersByPtyId.delete(ptyId)
    }
  }
  parkedWatcherDisposersByPtyId.set(ptyId, dispose)
  return dispose
}
