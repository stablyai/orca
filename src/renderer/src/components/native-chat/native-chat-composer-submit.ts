import { useAppStore } from '../../store'
import { emitNativeChatMessageSent } from '@/lib/native-chat-telemetry'
import { resolveNativeChatLaunchDraftSend } from './native-chat-launch-draft-send'
import {
  sendNativeChatMessage,
  sendNativeChatTypedCommand,
  sendNativeChatMessageWithImageAttachments,
  submitNativeChatPrompt,
  type NativeChatSendHandle
} from './native-chat-runtime-send'
import {
  isSlashCommandDraft,
  type NativeChatSendClassification
} from '../../../../shared/native-chat-slash-commands'
import type { NativeChatLaunchDraft } from '@/lib/native-chat-launch-prompt'
import { pushHistory, type HistoryState } from './native-chat-composer-state'
import {
  nativeChatComposerTargetIsRemote,
  type NativeChatResolvedTarget
} from './native-chat-composer-target'
import type { AgentType } from '../../../../shared/native-chat-types'

export function submitNativeChatComposerMessage(args: {
  text: string
  imagePaths: string[]
  disabled: boolean
  submitBlocked: boolean
  isDispatchingSessionOption: boolean
  resolveTarget: () => NativeChatResolvedTarget | null
  classifySend: (text: string) => NativeChatSendClassification
  wrapSubmittedText: (text: string, isSlashCommand: boolean) => string | null
  launchDraft?: NativeChatLaunchDraft | null
  launchDraftResolved: boolean
  agent: AgentType
  readTerminalScreen?: () => string | null
  trackPendingSend: (handle: NativeChatSendHandle, pendingId?: string) => void
  onSlashCommand?: (command: string) => void
  recordOutgoingCommand?: (command: string) => void
  onOptimisticSend?: (text: string, imagePaths: string[]) => string | undefined
  clearContext: () => void
  setHistory: (updater: (prev: HistoryState) => HistoryState) => void
  setDraft: (value: string) => void
  setCaret: (value: number) => void
  clearSkillOrigin: () => void
  clearImageAttachments: () => void
  setNotice: (value: string | null) => void
  terminalTabId: string
}): void {
  const { text, imagePaths } = args
  if ((text.trim() === '' && imagePaths.length === 0) || args.disabled || args.submitBlocked) {
    return
  }
  if (args.isDispatchingSessionOption) {
    return
  }
  const target = args.resolveTarget()
  if (!target) {
    return
  }
  const classification = args.classifySend(text)
  const submittedText = args.wrapSubmittedText(text, classification !== 'chat')
  if (submittedText === null) {
    return
  }
  const { sendOptions } = resolveNativeChatLaunchDraftSend({
    launchDraft: args.launchDraft,
    launchDraftResolved: args.launchDraftResolved,
    agent: args.agent,
    readScreen: () => args.readTerminalScreen?.()
  })
  let pendingHandle: NativeChatSendHandle | null = null
  if (classification !== 'chat' && imagePaths.length === 0) {
    pendingHandle =
      args.agent === 'codex' && isSlashCommandDraft(text)
        ? sendNativeChatTypedCommand(target.settings, target.ptyId, text)
        : sendNativeChatMessage(target.settings, target.ptyId, submittedText, sendOptions)
  } else if (imagePaths.length > 0) {
    pendingHandle = sendNativeChatMessageWithImageAttachments(
      target.settings,
      target.ptyId,
      submittedText,
      imagePaths,
      sendOptions
    )
  } else if (submittedText.trim().length > 0) {
    pendingHandle = sendNativeChatMessage(target.settings, target.ptyId, submittedText, sendOptions)
  } else {
    submitNativeChatPrompt(target.settings, target.ptyId)
  }
  if (classification !== 'chat') {
    if (pendingHandle) {
      args.trackPendingSend(pendingHandle)
    }
    if (classification === 'command') {
      args.onSlashCommand?.(text.trim())
      args.recordOutgoingCommand?.(text.trim())
    }
  } else {
    const pendingId = args.onOptimisticSend?.(text, imagePaths)
    if (pendingHandle) {
      args.trackPendingSend(pendingHandle, pendingId)
    }
    args.clearContext()
  }
  emitNativeChatMessageSent({
    agent: args.agent,
    runtime: nativeChatComposerTargetIsRemote(target.ptyId) ? 'remote' : 'local'
  })
  args.setHistory((prev) => pushHistory(prev, text))
  args.setDraft('')
  args.setCaret(0)
  args.clearSkillOrigin()
  args.clearImageAttachments()
  args.setNotice(null)
  useAppStore.getState().clearNativeChatLaunchDraft(args.terminalTabId)
}
