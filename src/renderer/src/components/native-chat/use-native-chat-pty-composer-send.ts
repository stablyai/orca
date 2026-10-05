import { useCallback, useEffect, type Dispatch, type SetStateAction } from 'react'
import type { AgentType } from '../../../../shared/agent-status-types'
import type { NativeChatLaunchDraft } from '@/lib/native-chat-launch-prompt'
import { useAppStore } from '../../store'
import { emitNativeChatMessageSent } from '@/lib/native-chat-telemetry'
import {
  sendNativeChatMessage,
  sendNativeChatTypedCommand,
  submitNativeChatPrompt
} from './native-chat-runtime-send'
import type { NativeChatSendHandle } from './native-chat-runtime-send'
import { sendNativeChatMessageWithImageAttachments } from './native-chat-runtime-image-send'
import { resolveNativeChatLaunchDraftSend } from './native-chat-launch-draft-send'
import {
  primeComposerSubmitBytes,
  resolveComposerSubmitBytes
} from './native-chat-claude-submit-cache'
import { nativeChatComposerTargetIsRemote } from './native-chat-composer-target'
import type { NativeChatResolvedTarget } from './native-chat-composer-target'
import { pushHistory, type HistoryState } from './native-chat-composer-state'
import { isSlashCommandDraft } from '../../../../shared/native-chat-slash-commands'
import type { NativeChatPickerState } from './use-native-chat-picker-state'
import type { NativeChatSendLifecycle } from './use-native-chat-send-lifecycle'
import type { NativeChatPtySessionOptionsSurface } from './native-chat-pty-session-options'
import type { NativeChatOptimisticSendOutcome } from './native-chat-composer-types'
import {
  answerNativeChatCommandInComposer,
  type NativeChatLocalCommandAnswer
} from './use-native-chat-local-command-answer'

export function useNativeChatPtyComposerSend(args: {
  agent: AgentType
  draft: string
  imageAttachments: readonly { path: string }[]
  disabled: boolean
  isDispatchingSessionOption: boolean
  launchDraft?: NativeChatLaunchDraft | null
  launchDraftResolved: boolean
  readTerminalScreen?: () => string | null
  resolveTarget: () => NativeChatResolvedTarget | null
  classifySend: NativeChatPickerState['classifySend']
  onOptimisticSend?: (text: string, imagePaths?: string[]) => string | undefined
  optimisticSendOutcome?: NativeChatOptimisticSendOutcome
  onSlashCommand?: (command: string, output?: string) => void
  answerCommandLocally?: NativeChatLocalCommandAnswer
  sessionOptionsSurface: NativeChatPtySessionOptionsSurface | null
  terminalTabId: string
  trackPendingSend: NativeChatSendLifecycle['trackPendingSend']
  setHistory: Dispatch<SetStateAction<HistoryState>>
  setDraft: (value: string) => void
  setCaret: Dispatch<SetStateAction<number>>
  clearSkillOrigin: () => void
  clearImageAttachments: () => void
  setNotice: Dispatch<SetStateAction<string | null>>
}): () => void {
  useEffect(() => {
    primeComposerSubmitBytes(args.agent)
  }, [args.agent])
  return useCallback(() => {
    const text = args.draft
    const imagePaths = args.imageAttachments.map((attachment) => attachment.path)
    if ((text.trim() === '' && imagePaths.length === 0) || args.disabled) {
      return
    }
    // Why: keep option-command and prompt writes from interleaving on the PTY input line.
    if (args.isDispatchingSessionOption) {
      return
    }
    const target = args.resolveTarget()
    if (!target) {
      return
    }
    const classification = args.classifySend(text)
    if (classification === 'command' && answerNativeChatCommandInComposer(args)) {
      return
    }
    const { sendOptions: launchSendOptions } = resolveNativeChatLaunchDraftSend({
      launchDraft: args.launchDraft,
      launchDraftResolved: args.launchDraftResolved,
      agent: args.agent,
      readScreen: () => args.readTerminalScreen?.()
    })
    let pendingId: string | undefined
    const sendOptions =
      args.agent === 'claude' && classification === 'chat'
        ? {
            ...launchSendOptions,
            onWriteRejected: () => {
              if (pendingId) {
                args.optimisticSendOutcome?.reject(pendingId)
              }
            },
            onWriteUnconfirmed: () => {
              if (pendingId) {
                args.optimisticSendOutcome?.holdUnconfirmed(pendingId)
              }
            }
          }
        : launchSendOptions
    // Submit with the gesture the user bound to chat:submit (from their Claude
    // keybindings) so a remapped Enter doesn't leave the message unsent. Only for
    // LOCAL Claude: Codex/others have their own config, and a remote pane's
    // keybindings live on its host, both keep the default CR.
    const submitBytes = resolveComposerSubmitBytes(
      args.agent,
      nativeChatComposerTargetIsRemote(target.ptyId)
    )
    const messageOptions = submitBytes !== undefined ? { ...sendOptions, submitBytes } : sendOptions
    let pendingHandle: NativeChatSendHandle | null = null
    // Why: slash-like text must not silently drop its attached images.
    if (classification !== 'chat' && imagePaths.length === 0) {
      pendingHandle =
        args.agent === 'codex' && isSlashCommandDraft(text)
          ? sendNativeChatTypedCommand(target.settings, target.ptyId, text)
          : sendNativeChatMessage(target.settings, target.ptyId, text, messageOptions)
    } else if (imagePaths.length > 0) {
      pendingHandle = sendNativeChatMessageWithImageAttachments(
        args.agent,
        target.settings,
        target.ptyId,
        text,
        imagePaths,
        messageOptions
      )
    } else if (text.trim().length > 0) {
      pendingHandle = sendNativeChatMessage(target.settings, target.ptyId, text, messageOptions)
    } else {
      submitNativeChatPrompt(target.settings, target.ptyId)
    }
    if (classification !== 'chat') {
      if (pendingHandle) {
        args.trackPendingSend(pendingHandle)
      }
      if (classification === 'command') {
        args.onSlashCommand?.(text.trim())
        args.sessionOptionsSurface?.recordOutgoingCommand(text.trim())
      }
    } else {
      pendingId = args.onOptimisticSend?.(text, imagePaths)
      if (pendingHandle) {
        args.trackPendingSend(pendingHandle, pendingId)
      }
    }
    emitNativeChatMessageSent({
      agent: args.agent,
      runtime: nativeChatComposerTargetIsRemote(target.ptyId) ? 'remote' : 'local'
    })
    args.setHistory((previous) => pushHistory(previous, text))
    args.setDraft('')
    args.setCaret(0)
    args.clearSkillOrigin()
    args.clearImageAttachments()
    args.setNotice(null)
    useAppStore.getState().clearNativeChatLaunchDraft(args.terminalTabId)
  }, [args])
}
