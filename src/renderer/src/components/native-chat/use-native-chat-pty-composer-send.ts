import { useCallback, type Dispatch, type SetStateAction } from 'react'
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
import { nativeChatComposerTargetIsRemote } from './native-chat-composer-target'
import type { NativeChatResolvedTarget } from './native-chat-composer-target'
import { pushHistory, type HistoryState } from './native-chat-composer-state'
import { isSlashCommandDraft } from '../../../../shared/native-chat-slash-commands'
import type { NativeChatPickerState } from './use-native-chat-picker-state'
import type { NativeChatSendLifecycle } from './use-native-chat-send-lifecycle'
import type { NativeChatPtySessionOptionsSurface } from './native-chat-pty-session-options'

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
  onSlashCommand?: (command: string) => void
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
    const { sendOptions } = resolveNativeChatLaunchDraftSend({
      launchDraft: args.launchDraft,
      launchDraftResolved: args.launchDraftResolved,
      agent: args.agent,
      readScreen: () => args.readTerminalScreen?.()
    })
    let pendingHandle: NativeChatSendHandle | null = null
    // Why: slash-like text must not silently drop its attached images.
    if (classification !== 'chat' && imagePaths.length === 0) {
      pendingHandle =
        args.agent === 'codex' && isSlashCommandDraft(text)
          ? sendNativeChatTypedCommand(target.settings, target.ptyId, text)
          : sendNativeChatMessage(target.settings, target.ptyId, text, sendOptions)
    } else if (imagePaths.length > 0) {
      pendingHandle = sendNativeChatMessageWithImageAttachments(
        target.settings,
        target.ptyId,
        text,
        imagePaths,
        sendOptions
      )
    } else if (text.trim().length > 0) {
      pendingHandle = sendNativeChatMessage(target.settings, target.ptyId, text, sendOptions)
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
      const pendingId = args.onOptimisticSend?.(text, imagePaths)
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
