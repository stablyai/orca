import { useCallback, type Dispatch, type SetStateAction } from 'react'
import type { AgentType } from '../../../../shared/agent-status-types'
import type { NativeChatLaunchDraft } from '@/lib/native-chat-launch-prompt'
import type { NativeChatPtySessionOptionsSurface } from './native-chat-pty-session-options'
import {
  nativeChatComposerTargetIsRemote,
  type NativeChatResolvedTarget
} from './native-chat-composer-target'
import {
  pushHistory,
  type HistoryState,
  type NativeChatSendClassification
} from './native-chat-composer-state'
import type { NativeChatSendLifecycle } from './use-native-chat-send-lifecycle'
import {
  sendNativeChatMessage,
  sendNativeChatTypedCommand,
  sendNativeChatMessageWithImageAttachments,
  submitNativeChatPrompt,
  type NativeChatSendHandle
} from './native-chat-runtime-send'
import { resolveNativeChatLaunchDraftSend } from './native-chat-launch-draft-send'
import { emitNativeChatMessageSent } from '@/lib/native-chat-telemetry'
import { useAppStore } from '../../store'
import { translate } from '@/i18n/i18n'
import { isSlashCommandDraft } from '../../../../shared/native-chat-slash-commands'

export function useNativeChatComposerSend(args: {
  agent: AgentType
  draft: string
  imageAttachments: readonly { path: string }[]
  disabled: boolean
  isDispatchingSessionOption: boolean
  launchDraft?: NativeChatLaunchDraft | null
  launchDraftResolved: boolean
  readTerminalScreen?: () => string | null
  resolveTarget: () => NativeChatResolvedTarget | null
  classifySend: (text: string) => NativeChatSendClassification
  clearSkillOrigin: () => void
  clearImageAttachments: () => void
  onOptimisticSend?: (text: string, imagePaths?: string[]) => string | undefined
  onSlashCommand?: (command: string) => void
  sessionOptionsSurface: NativeChatPtySessionOptionsSurface | null
  terminalTabId: string
  trackPendingSend: NativeChatSendLifecycle['trackPendingSend']
  setDraft: (value: string) => void
  setCaret: Dispatch<SetStateAction<number>>
  setHistory: Dispatch<SetStateAction<HistoryState>>
  setNotice: Dispatch<SetStateAction<string | null>>
  setVerifiedSendPending: Dispatch<SetStateAction<boolean>>
}): () => void {
  const {
    agent,
    draft,
    imageAttachments,
    disabled,
    isDispatchingSessionOption,
    launchDraft,
    launchDraftResolved,
    readTerminalScreen,
    resolveTarget,
    classifySend,
    clearSkillOrigin,
    clearImageAttachments,
    onOptimisticSend,
    onSlashCommand,
    sessionOptionsSurface,
    terminalTabId,
    trackPendingSend,
    setDraft,
    setCaret,
    setHistory,
    setNotice,
    setVerifiedSendPending
  } = args
  return useCallback(() => {
    const imagePaths = imageAttachments.map((attachment) => attachment.path)
    if (
      (draft.trim() === '' && imagePaths.length === 0) ||
      disabled ||
      isDispatchingSessionOption
    ) {
      return
    }
    const target = resolveTarget()
    if (!target) {
      return
    }
    const classification = classifySend(draft)
    const { sendOptions } = resolveNativeChatLaunchDraftSend({
      launchDraft,
      launchDraftResolved,
      agent,
      readScreen: () => readTerminalScreen?.()
    })
    const routedSendOptions = { ...sendOptions, writer: target.writer }
    let handle: NativeChatSendHandle | null = null
    if (classification !== 'chat' && imagePaths.length === 0) {
      handle =
        agent === 'codex' && isSlashCommandDraft(draft)
          ? sendNativeChatTypedCommand(target.settings, target.ptyId, draft, target.writer)
          : sendNativeChatMessage(target.settings, target.ptyId, draft, routedSendOptions)
    } else if (imagePaths.length > 0) {
      handle = sendNativeChatMessageWithImageAttachments(
        target.settings,
        target.ptyId,
        draft,
        imagePaths,
        routedSendOptions
      )
    } else if (draft.trim()) {
      handle = sendNativeChatMessage(target.settings, target.ptyId, draft, routedSendOptions)
    } else {
      submitNativeChatPrompt(target.settings, target.ptyId, target.writer)
    }

    const finishAcceptedSend = (trackHandle: boolean): void => {
      if (classification !== 'chat') {
        if (trackHandle && handle) {
          trackPendingSend(handle)
        }
        if (classification === 'command') {
          onSlashCommand?.(draft.trim())
          sessionOptionsSurface?.recordOutgoingCommand(draft.trim())
        }
      } else {
        const pendingId = onOptimisticSend?.(draft, imagePaths)
        if (trackHandle && handle) {
          trackPendingSend(handle, pendingId)
        }
      }
      emitNativeChatMessageSent({
        agent,
        runtime: nativeChatComposerTargetIsRemote(target.ptyId) ? 'remote' : 'local'
      })
      setHistory((previous) => pushHistory(previous, draft))
      setDraft('')
      setCaret(0)
      clearSkillOrigin()
      clearImageAttachments()
      setNotice(null)
      useAppStore.getState().clearNativeChatLaunchDraft(terminalTabId)
    }
    if (handle?.delivered) {
      setVerifiedSendPending(true)
      trackPendingSend(handle)
      void handle.delivered
        .catch(() => false)
        .then((delivered) => {
          if (delivered) {
            finishAcceptedSend(false)
            return
          }
          setNotice(
            translate(
              'components.native-chat.composer.sendRejected',
              'The terminal did not accept the message. Try again.'
            )
          )
        })
        .finally(() => setVerifiedSendPending(false))
      return
    }
    finishAcceptedSend(true)
  }, [
    agent,
    classifySend,
    clearImageAttachments,
    clearSkillOrigin,
    disabled,
    draft,
    imageAttachments,
    isDispatchingSessionOption,
    launchDraft,
    launchDraftResolved,
    onOptimisticSend,
    onSlashCommand,
    readTerminalScreen,
    resolveTarget,
    sessionOptionsSurface,
    setCaret,
    setDraft,
    setHistory,
    setNotice,
    setVerifiedSendPending,
    terminalTabId,
    trackPendingSend
  ])
}
