import type { AgentQuestionAnsweredInferenceRequest } from '../../../../shared/agent-question-answered-intent'
import type { NativeChatSession } from '../../../../shared/native-chat-types'
import type { NativeChatAttachmentOwner } from './native-chat-attachment-upload'
import type { NativeChatContextMenuActions } from './use-native-chat-context-menu'
import type { NativeChatFileLinkContext } from './native-chat-file-link'
import type { NativeChatPtyWriter } from './native-chat-pty-writer'

export type NativeChatConversationProps = {
  paneKey: string
  agent: NativeChatSession['agent']
  sessionId: string | null
  transcriptPath: string | null
  targetPtyId: string | null
  terminalTabId: string
  /** Suspends transcript work while the hosting surface is hidden. */
  isVisible?: boolean
  onSwitchToTerminal?: () => void
  readTerminalScreen?: () => string | null
  contextMenuActions?: Omit<NativeChatContextMenuActions, 'onPaste'>
  ptyWriter?: NativeChatPtyWriter
  attachmentOwner?: NativeChatAttachmentOwner
  fileLinkContext?: NativeChatFileLinkContext
  fileLinksEnabled?: boolean
  dictationEnabled?: boolean
  sessionOptionsEnabled?: boolean
  fileDropEnabled?: boolean
  liveState?: NativeChatConversationLiveState
}

export type NativeChatConversationLiveState = {
  working: boolean
  stateStartedAt: number | null
  lastAssistantMessage: string | null
  interactivePrompt: string | null
  interactiveToolName: string | null
  questionInferenceRequest?: AgentQuestionAnsweredInferenceRequest
}
