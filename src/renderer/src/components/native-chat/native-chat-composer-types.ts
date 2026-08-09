import type { AgentType } from '../../../../shared/agent-status-types'
import type { NativeChatLaunchDraft } from '@/lib/native-chat-launch-prompt'

export type NativeChatComposerProps = {
  /** Tab hosting the agent; used to resolve the live ptyId + runtime settings. */
  terminalTabId: string
  /** Stable split-leaf identity; unlike a PTY id, this survives reconnects. */
  paneKey: string
  /** Specific split-pane PTY this chat view owns. */
  targetPtyId: string | null
  agent: AgentType
  /** Guard desktop sends while a mobile client owns the terminal input lease. */
  canSend?: boolean
  /** True while the hosted TUI reports an in-flight turn; swaps Send to Stop. */
  isWorking?: boolean
  /** Interrupt the hosted agent, usually by sending ESC into the PTY. */
  onStop?: () => void
  /** Render an optimistic echo until the real transcript turn lands. */
  onOptimisticSend?: (text: string, imagePaths?: string[]) => string | undefined
  /** Remove an optimistic echo when its delayed submit is canceled. */
  onOptimisticSendCanceled?: (pendingId: string) => void
  /** Arm delivery confirmation once this pending send's Enter write fires. */
  onOptimisticSendSubmitted?: (pendingId: string) => void
  /** Record a dispatched slash command that does not create a chat turn. */
  onSlashCommand?: (command: string) => void
  /** Picker-only agent commands continue in the hosted TUI after dispatch. */
  onSwitchToTerminal?: () => void
  /** Reads the hosted TUI's current rendered screen when chat is entered. */
  readTerminalScreen?: () => string | null
  /** Launch context prefilled into the TUI input as an unsent draft; adopted as the composer draft. */
  launchDraft?: NativeChatLaunchDraft | null
  /** True once the transcript shows the TUI-side draft was submitted or cleared. */
  launchDraftResolved?: boolean
}

export type NativeChatComposerHandle = {
  focus: () => boolean
  insertTypedText: (text: string) => boolean
  /** Routes pane-level paste events back to the composer field. */
  handlePasteEvent: (event: {
    clipboardData: DataTransfer | null
    preventDefault: () => void
    defaultPrevented: boolean
  }) => void
  /** Pastes clipboard content when no DOM paste event is available. */
  pasteFromClipboard: () => void
  /** Restore a failed send without discarding newer composer edits. */
  restoreFailedMessage: (text: string, imagePaths?: string[]) => boolean
}
