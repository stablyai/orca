import { captureTerminalAgentImageTarget } from '@/runtime/files/agent-image-preparation'
import { parsePaneKey } from '../../../../../../shared/workspace-layout/stable-pane-id'
import { readNativeChatComposerDraft } from '../../drafts/native-chat-composer-draft-store'
import { serializeNativeChatAgentReferences } from '../pickers/native-chat-agent-reference-send'
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
import { resolveNativeChatAttachmentOwner } from '../../attachments/uploads/native-chat-attachment-owner'
import { resolveNativeChatLaunchDraftSend } from '../../drafts/native-chat-launch-draft-send'
import {
  nativeChatComposerTargetIsRemote,
  type NativeChatResolvedTarget
} from './native-chat-composer-target'
import { isSlashCommandDraft } from '../../../../../../shared/native-chat/input/commands/native-chat-slash-commands'
import type { NativeChatPickerState } from '../pickers/use-native-chat-picker-state'
import type { NativeChatSendLifecycle } from '../../session/terminal/send/use-native-chat-send-lifecycle'
import type { NativeChatPtySessionOptionsSurface } from '../../../../../../shared/native-chat/input/session-options/native-chat-pty-session-options'
import type { NativeChatOptimisticSendOutcome } from '../../session/terminal/delivery/native-chat-optimistic-send-outcome'
import {
  answerNativeChatCommandInComposer,
  type NativeChatLocalCommandAnswer
} from '../../session/options/terminal/use-native-chat-local-command-answer'

export function useNativeChatPtyComposerSend(args: {
  agent: AgentType
  paneKey: string
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
      const observedSendOptions =
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
      const sendOptions = {
        ...observedSendOptions,
        onImagesPrepared: (paths: readonly string[]) => {
          if (pendingId) {
            args.optimisticSendOutcome?.recordImageDelivery?.(pendingId, paths)
          }
        }
      }
      let pendingHandle: NativeChatSendHandle | null = null
      // Why: slash-like text must not silently drop its attached images.
      if (classification !== 'chat' && imagePaths.length === 0) {
        pendingHandle =
          args.agent === 'codex' && isSlashCommandDraft(text)
            ? sendNativeChatTypedCommand(target.ptyId, text, launchSendOptions)
            : sendNativeChatMessage(target.ptyId, text, sendOptions)
      } else if (imagePaths.length > 0) {
        const pane = parsePaneKey(args.paneKey)
        const imageTarget = pane ? captureTerminalAgentImageTarget(pane.tabId, pane.leafId) : null
        if (pane && !imageTarget) {
          args.setNotice(translate('components.native-chat.messageNotSent', 'Message not sent'))
          return false
        }
        const owner = resolveNativeChatAttachmentOwner(useAppStore.getState(), args.terminalTabId)
        pendingHandle = sendNativeChatMessageWithImageAttachments(
          args.agent,
          target.ptyId,
          text,
          imagePaths,
          {
            ...sendOptions,
            isCurrent: imageTarget?.isCurrent,
            executionHostId: owner.kind === 'remote' ? owner.staging?.executionHostId : undefined
          }
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
          if ((retry || imagePaths.length > 0) && pendingId) {
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
