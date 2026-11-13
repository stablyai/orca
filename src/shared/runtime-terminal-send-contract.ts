import type { TerminalChatExpiry } from './terminal/input/terminal-chat-prompt-budget'
import type { WriteSettlement } from './terminal/pty/lifecycle/pty-write-settlement'
import type { TuiAgent } from './agent-launch/catalog/tui-agent'
import type { NativeChatPromptBinding } from './native-chat/input/native-chat-prompt-observation'

export type TerminalChatPrompt = { agent: TuiAgent; text: string; expiry?: TerminalChatExpiry }

export type RuntimeTerminalSend = {
  handle: string
  accepted: boolean
  bytesWritten: number
  chatPromptNotDispatched?: 'unsupported'
  chatPromptBinding?: NativeChatPromptBinding
  refusedReason?: 'no-agent' | 'permission'
  prompt?: RuntimeTerminalPromptDelivery
  writeSettlement?: WriteSettlement
}

export type RuntimeTerminalPromptStage = 'input_accepted' | 'turn_started'

export type RuntimeTerminalPromptDelivery = {
  requestId: string
  stages: RuntimeTerminalPromptStage[]
  provider: 'antigravity' | 'claude' | 'codex' | 'unsupported' | 'old-host'
  observation: 'supported' | 'unsupported' | 'incarnation_replaced' | 'permission'
  processIncarnation: string
  generation: number
  baselineWorkingSequence: number
  /** Hook turn-start timestamp before this prompt was accepted. */
  baselineExplicitWorkingStartedAt?: number | null
  /** Permission observations seen before this prompt was accepted. */
  baselinePermissionSequence?: number
}
