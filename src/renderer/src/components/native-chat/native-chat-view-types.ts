import type { TuiAgent } from '../../../../shared/types'
import type { NativeChatContextMenuActions } from './use-native-chat-context-menu'

export type NativeChatViewProps = {
  /** The terminal tab hosting the agent. paneKey is `${tabId}:${leafId}`. */
  terminalTabId: string
  /** Specific split leaf this chat surface replaces. */
  paneKey?: string
  /** PTY bound to `paneKey`, used for composer and interactive-card sends. */
  targetPtyId?: string | null
  /** Launch-time agent hint from the TerminalTab, when Orca started one. */
  launchAgent?: TuiAgent | null
  /** Trusted title/foreground fallback for manually-started agents. */
  resolvedAgent?: TuiAgent | null
  /** Return this pane to the hosted terminal surface. */
  onSwitchToTerminal?: () => void
  /** Current xterm screen reader used to recover agent-reported session state. */
  readTerminalScreen?: () => string | null
  contextMenuActions?: Omit<NativeChatContextMenuActions, 'onPaste'>
}
