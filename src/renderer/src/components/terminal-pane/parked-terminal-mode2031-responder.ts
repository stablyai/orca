/**
 * DECSET 2031 color-scheme responder for parked terminals (byte-scan mode).
 *
 * Why a dedicated byte sidecar: no xterm exists while a tab is parked, so
 * nothing answers a TUI's mode-2031 theme subscription. Query authority stays
 * with the view/watcher (model/view contract invariant 6), so this reply can
 * never move to main. Phase 4: this subscribeToPtyData registration doubles
 * as a delivery-interest signal, so it is only used while the hidden-delivery
 * gate is OFF — gated parked PTYs answer from the main tracker's
 * '2031-subscribe' fact instead (parked-terminal-byte-watcher.ts).
 *
 * Survives Phase 6 (skip-grammar deletion): mounted switch-off hidden panes
 * answer 2031 from xterm once the background queue drains, but a PARKED tab
 * has no xterm in any switch-off mode, and the '2031-subscribe' fact is only
 * consumed while the gate is ON — this sidecar stays the only answerer here.
 */
import {
  INITIAL_MODE_2031_REPLY_SCAN_STATE,
  mode2031SequenceFor,
  resolveTerminalColorSchemeMode,
  scanMode2031ReplyDecision
} from '../../../../shared/terminal-color-scheme-protocol'
import { useAppStore } from '@/store'
import { getSystemPrefersDark } from '@/lib/terminal-theme'
import { subscribeToPtyData } from './pty-data-sidecar-subscriptions'

export type ParkedTerminalMode2031ResponderOptions = {
  ptyId: string
  /** Out-of-band reply channel to the PTY (mode-2031 color-scheme answers). */
  sendInput: (data: string) => void
}

export function startParkedTerminalMode2031Responder(
  options: ParkedTerminalMode2031ResponderOptions
): () => void {
  const { ptyId, sendInput } = options
  let scanState = INITIAL_MODE_2031_REPLY_SCAN_STATE
  return subscribeToPtyData(ptyId, (data) => {
    const result = scanMode2031ReplyDecision(scanState, data)
    scanState = result.state
    if (result.decision !== 'subscribed') {
      return
    }
    // Why: reply with the resolved theme so TUIs that subscribe while parked
    // still learn it before the pane is ever revealed.
    const settings = useAppStore.getState().settings
    sendInput(mode2031SequenceFor(resolveTerminalColorSchemeMode(settings, getSystemPrefersDark())))
  })
}
