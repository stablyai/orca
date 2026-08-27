import type { AgentType } from '../../../../shared/agent-status-types'
import { isSlashCommandDraft } from '../../../../shared/native-chat-slash-commands'
import type { NativeChatResolvedTarget } from './native-chat-composer-target'
import type { NativeChatSendClassification } from './native-chat-picker-items'
import {
  sendNativeChatMessage,
  sendNativeChatTypedCommand,
  sendNativeChatMessageWithImageAttachments,
  submitNativeChatPrompt,
  type NativeChatSendHandle
} from './native-chat-runtime-send'

export type NativeChatComposerSendOptions =
  | { clearInput: string; confirmCleared: () => boolean }
  | undefined

/** Picks the send path for an already-classified draft. Pure dispatch: the
 *  composer keeps the state updates, this only decides which writer runs. */
export function startNativeChatComposerSend(args: {
  agent: AgentType
  text: string
  imagePaths: string[]
  target: NativeChatResolvedTarget
  classification: NativeChatSendClassification
  sendOptions: NativeChatComposerSendOptions
}): NativeChatSendHandle | null {
  const { agent, text, imagePaths, target, classification, sendOptions } = args
  // Why: image attachments take the attachment send path even for a
  // command/unknown send, otherwise the composer's clearImageAttachments()
  // drops them silently when the text starts with the agent's slash prefix.
  if (classification !== 'chat' && imagePaths.length === 0) {
    return agent === 'codex' && isSlashCommandDraft(text)
      ? sendNativeChatTypedCommand(target.settings, target.ptyId, text)
      : sendNativeChatMessage(target.settings, target.ptyId, text, sendOptions)
  }
  if (imagePaths.length > 0) {
    return sendNativeChatMessageWithImageAttachments(
      target.settings,
      target.ptyId,
      text,
      imagePaths,
      sendOptions
    )
  }
  if (text.trim().length > 0) {
    return sendNativeChatMessage(target.settings, target.ptyId, text, sendOptions)
  }
  submitNativeChatPrompt(target.settings, target.ptyId)
  return null
}
