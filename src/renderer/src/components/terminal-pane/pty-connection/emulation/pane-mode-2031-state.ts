import { useAppStore } from '@/store'
import { getSystemPrefersDark } from '@/lib/terminal-theme'
import {
  resolveTerminalColorSchemeMode,
  scanMode2031ReplyDecision,
  INITIAL_MODE_2031_REPLY_SCAN_STATE
} from '../../../../../../shared/terminal/protocol/queries/terminal-color-scheme-protocol'
import type { ConnectPanePtySession } from '../connect-pane-pty-session'

import { maybePushMode2031Flip } from '../../emulation/terminal-mode-2031-replies'

export function bindLivePaneMode2031Observation(session: ConnectPanePtySession): void {
  // DECSET 2031 subscribes silently; late replies paint junk after fish withdraws it (#9993). Scan raw chunks because xterm batching hides per-chunk subscription state.
  session.observeLiveMode2031Chunk = function (data: string): void {
    // Gate-managed PTYs never see these bytes; main's '2031-subscribe' fact records them.
    if (session.isHiddenDeliveryGateManagedPty(session.transport.getPtyId())) {
      return
    }
    const result = scanMode2031ReplyDecision(session.mode2031ReplyScanState, data)
    session.mode2031ReplyScanState = result.state
    if (result.decision === 'unsubscribed') {
      session.deps.paneMode2031Ref.current.delete(session.pane.id)
      session.deps.paneLastThemeModeRef.current.delete(session.pane.id)
    }
    // A repeated DECSET must not overwrite a report still owed after a hold or outage.
    if (
      result.decision !== 'subscribed' ||
      session.deps.paneMode2031Ref.current.get(session.pane.id)
    ) {
      return
    }
    const settings = useAppStore.getState().settings
    // Seed the current mode so unrelated appearance reapply cannot masquerade as a theme flip.
    session.deps.paneMode2031Ref.current.set(session.pane.id, true)
    session.deps.paneLastThemeModeRef.current.set(
      session.pane.id,
      resolveTerminalColorSchemeMode(settings, getSystemPrefersDark())
    )
  }
}

export function bindPaneMode2031Reset(session: ConnectPanePtySession): void {
  session.clearPaneMode2031State = function (): void {
    session.deps.paneMode2031Ref.current.delete(session.pane.id)
    session.deps.paneLastThemeModeRef.current.delete(session.pane.id)
    // Drop partial CSI tails on PTY replacement so unrelated streams cannot form a fabricated sequence.
    session.mode2031ReplyScanState = INITIAL_MODE_2031_REPLY_SCAN_STATE
  }
}

export function bindHiddenPaneMode2031Facts(session: ConnectPanePtySession): void {
  // Gated panes see no subscription bytes; record the fact for later theme flips without replying to subscribe (#9993).
  session.handleHiddenMode2031SubscribeFact = (): void => {
    const ptyId = session.transport.getPtyId()
    if (
      session.disposed ||
      (!session.isHiddenDeliveryGateManagedPty(ptyId) && session.remoteOutputGatedPtyId !== ptyId)
    ) {
      return
    }
    const mode = resolveTerminalColorSchemeMode(
      useAppStore.getState().settings,
      getSystemPrefersDark()
    )
    session.deps.recordPaneMode2031Subscription?.(session.pane.id, mode)
  }
  // Report a mode change skipped while the stream was down or another viewer held the grid (#10913).
  session.catchUpMode2031 = (): void => {
    maybePushMode2031Flip(
      session.pane.id,
      resolveTerminalColorSchemeMode(useAppStore.getState().settings, getSystemPrefersDark()),
      session.transport,
      session.deps.paneMode2031Ref.current,
      session.deps.paneLastThemeModeRef.current
    )
  }
  // Only facts retire gated subscriptions; missing withdrawal bytes would otherwise send theme replies to the replacement shell (#9993).
  session.handleHiddenMode2031UnsubscribeFact = (): void => {
    const ptyId = session.transport.getPtyId()
    if (
      session.disposed ||
      (!session.isHiddenDeliveryGateManagedPty(ptyId) && session.remoteOutputGatedPtyId !== ptyId)
    ) {
      return
    }
    session.deps.paneMode2031Ref.current.delete(session.pane.id)
    session.deps.paneLastThemeModeRef.current.delete(session.pane.id)
  }
}
