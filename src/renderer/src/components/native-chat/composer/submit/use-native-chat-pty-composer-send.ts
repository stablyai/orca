import { readNativeChatComposerDraft } from '../../drafts/native-chat-composer-draft-store'
import { formatAgentTypeLabel } from '../../../../../../shared/agent-status/presentation/agent-type-label'
import { serializeNativeChatAgentReferences } from '../pickers/native-chat-agent-reference-send'
import {
  nativeChatReplyCustody,
  readNativeChatReplyTarget,
  restoreNativeChatReplyTarget,
  settleNativeChatReplySend
} from '../reply/native-chat-reply-target'
import { withNativeChatReplyContext } from '../reply/native-chat-reply-quote'
import { rememberNativeChatReplySource } from '../reply/native-chat-reply-sources'
import {
  admitNativeChatPastedText,
  resolveNativeChatPastedText
} from '../../paste/native-chat-composer-pasted-text-references'
import { useCallback, type Dispatch, type SetStateAction } from 'react'
import type { AgentType } from '../../../../../../shared/agent-status/contracts/agent-status-types'
import type { NativeChatLaunchDraft } from '@/components/native-chat/drafts/native-chat-launch-prompt'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '../../../../store/index'
import { emitNativeChatMessageSent } from '@/components/native-chat/telemetry/native-chat-telemetry'
import {
  sendNativeChatMessage,
  sendNativeChatTypedCommand,
  submitNativeChatPrompt,
  type NativeChatSendHandle
} from '../../session/terminal/send/native-chat-runtime-send'
import { sendNativeChatMessageWithImageAttachments } from '../../session/terminal/send/native-chat-runtime-image-send'
import { resolveNativeChatLaunchDraftSend } from '../../drafts/native-chat-launch-draft-send'
import {
  nativeChatComposerTargetIsRemote,
  type NativeChatResolvedTarget
} from './native-chat-composer-target'
import { isSlashCommandDraft } from '../../../../../../shared/native-chat/input/commands/native-chat-slash-commands'
import type { NativeChatPickerState } from '../pickers/use-native-chat-picker-state'
import type { NativeChatSendClassification } from '../../../../../../shared/native-chat/input/commands/native-chat-slash-commands'
import type { NativeChatSendLifecycle } from '../../session/terminal/send/use-native-chat-send-lifecycle'
import type { NativeChatPtySessionOptionsSurface } from '../../../../../../shared/native-chat/input/session-options/native-chat-pty-session-options'
import type { NativeChatOptimisticSendOutcome } from '../../session/terminal/delivery/native-chat-optimistic-send-outcome'
import {
  answerNativeChatCommandInComposer,
  type NativeChatLocalCommandAnswer
} from '../../session/options/terminal/use-native-chat-local-command-answer'

/** How a terminal chat delivers a send: slash-like text alone is typed as a command; anything with images is a message. */
export function nativeChatPtySendRoute(
  classification: NativeChatSendClassification,
  imageCount: number
): 'command' | 'message' {
  return classification !== 'chat' && imageCount === 0 ? 'command' : 'message'
}

export function useNativeChatPtyComposerSend(args: {
  agent: AgentType
  draft: string
  draftScopeKey: string
  imageAttachments: readonly { path: string }[]
  disabled: boolean
  isDispatchingSessionOption: boolean
  launchDraft?: NativeChatLaunchDraft | null
  launchDraftResolved: boolean
  readTerminalDraft?: () => string | null
  resolveTarget: () => NativeChatResolvedTarget | null
  classifySend: NativeChatPickerState['classifySend']
  onOptimisticSend?: (text: string, imagePaths?: string[], recovery?: boolean) => string | undefined
  optimisticSendOutcome?: NativeChatOptimisticSendOutcome
  onSlashCommand?: (command: string, output?: string) => void
  onCommandSent?: (command: string, delivery: NativeChatSendHandle) => void
  answerCommandLocally?: NativeChatLocalCommandAnswer
  onSubmitted?: () => void
  sessionOptionsSurface: NativeChatPtySessionOptionsSurface | null
  terminalTabId: string
  trackPendingSend: NativeChatSendLifecycle['trackPendingSend']
  setDraft: (value: string) => void
  setCaret: Dispatch<SetStateAction<number>>
  clearSkillOrigin: () => void
  clearImageAttachments: () => void
  setNotice: (notice: string | null) => void
}): (retry?: { text: string; imagePaths?: string[] }) => boolean {
  return useCallback(
    (retry) => {
      let text = retry?.text ?? args.draft
      const imagePaths =
        retry?.imagePaths ??
        (retry ? [] : args.imageAttachments.map((attachment) => attachment.path))
      if ((text.trim() === '' && imagePaths.length === 0) || args.disabled) {
        return false
      }
      // Why: keep option-command and prompt writes from interleaving on the PTY input line.
      if (args.isDispatchingSessionOption) {
        return false
      }
      const target = args.resolveTarget()
      if (!target) {
        return false
      }
      const classification = retry ? 'chat' : args.classifySend(text)
      if (classification === 'command' && answerNativeChatCommandInComposer(args)) {
        return false
      }
      if (!admitNativeChatPastedText(args.draftScopeKey, text, args.setNotice)) {
        return false
      }
      const submitted = readNativeChatComposerDraft(args.draftScopeKey)
      text = retry
        ? resolveNativeChatPastedText(args.draftScopeKey, text)
        : serializeNativeChatAgentReferences(text, submitted.document, submitted.pastedTextFiles)
      // Quoted once into the sent text; a retry resends that text and never reads the current reply.
      const route = nativeChatPtySendRoute(classification, imagePaths.length)
      // Only a message carries the reply; a real command keeps it for the next message.
      const reply =
        !retry && route === 'message' && classification !== 'command'
          ? readNativeChatReplyTarget(args.draftScopeKey)
          : null
      if (reply) {
        text = withNativeChatReplyContext(text, reply, formatAgentTypeLabel(args.agent))
      }
      const { sendOptions: launchSendOptions } = resolveNativeChatLaunchDraftSend({
        launchDraft: args.launchDraft,
        launchDraftResolved: args.launchDraftResolved,
        agent: args.agent,
        readInputLine: () => args.readTerminalDraft?.()
      })
      if (launchSendOptions.clearInput === null) {
        args.setNotice(translate('components.native-chat.messageNotSent', 'Message not sent'))
        return false
      }
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
      let pendingHandle: NativeChatSendHandle | null = null
      // Why: slash-like text must not silently drop its attached images.
      if (route === 'command') {
        pendingHandle =
          args.agent === 'codex' && isSlashCommandDraft(text)
            ? sendNativeChatTypedCommand(target.ptyId, text, launchSendOptions)
            : sendNativeChatMessage(target.ptyId, text, sendOptions)
      } else if (imagePaths.length > 0) {
        pendingHandle = sendNativeChatMessageWithImageAttachments(
          args.agent,
          target.ptyId,
          text,
          imagePaths,
          sendOptions
        )
      } else if (text.trim().length > 0) {
        pendingHandle = sendNativeChatMessage(target.ptyId, text, sendOptions)
      } else {
        submitNativeChatPrompt(target.ptyId)
      }
      if (classification !== 'chat') {
        if (pendingHandle) {
          args.trackPendingSend(pendingHandle)
        }
        if (classification === 'command') {
          args.onSlashCommand?.(text.trim())
          args.sessionOptionsSurface?.recordOutgoingCommand(text.trim())
          if (pendingHandle) {
            args.onCommandSent?.(text.trim(), pendingHandle)
          }
        }
      } else {
        pendingId = args.onOptimisticSend?.(text, imagePaths, retry !== undefined)
        if (pendingHandle) {
          args.trackPendingSend(pendingHandle, pendingId)
          if (retry && pendingId) {
            const id = pendingId
            void pendingHandle.outcome?.then((outcome) => {
              if (outcome === 'not-submitted') {
                args.optimisticSendOutcome?.reject(id)
              } else if (outcome === 'uncertain') {
                args.optimisticSendOutcome?.holdUnconfirmed(id)
              }
            })
          }
        }
      }
      emitNativeChatMessageSent({
        agent: args.agent,
        runtime: nativeChatComposerTargetIsRemote(target.ptyId) ? 'remote' : 'local'
      })
      args.onSubmitted?.()
      if (!retry) {
        if (reply) {
          // A shown message that isn't sent comes back as "not sent → Edit", rebuilt from this text,
          // so it keeps its exact original. Otherwise only a write the terminal took answers it.
          const outcome = pendingId ? undefined : pendingHandle?.outcome
          if (outcome) {
            void outcome.then((result) => {
              if (result !== 'not-submitted') {
                rememberNativeChatReplySource(args.draftScopeKey, text, reply.messageId)
              }
            })
          } else {
            rememberNativeChatReplySource(args.draftScopeKey, text, reply.messageId)
          }
        }
        // A shown message returns as "not sent → Edit" with its quote; without one, nothing returns
        // the text, so a rejected write at least puts the reply back.
        if (settleNativeChatReplySend(args.draftScopeKey, reply?.id) && reply && !pendingId) {
          const takenAt = nativeChatReplyCustody(args.draftScopeKey)
          void pendingHandle?.outcome?.then((outcome) => {
            if (outcome === 'not-submitted') {
              restoreNativeChatReplyTarget(args.draftScopeKey, reply, takenAt)
            }
          })
        }
        args.setDraft('')
        args.setCaret(0)
        args.clearSkillOrigin()
        args.clearImageAttachments()
        args.setNotice(null)
        useAppStore.getState().clearNativeChatLaunchDraft(args.terminalTabId)
      }
      return true
    },
    [args]
  )
}
