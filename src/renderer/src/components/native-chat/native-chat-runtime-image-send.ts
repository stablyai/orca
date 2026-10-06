import { sendNativeChatObservedWrites } from './native-chat-observed-send'
import { agentImagePasteWrites, formatAgentImagePath } from '../../../../shared/agent-image-paste'
import type { AgentType } from '../../../../shared/agent-status-types'
import { sendRuntimePtyInput } from '@/runtime/runtime-terminal-inspection'
import type { getSettingsForAgentTabRuntimeOwner } from '@/lib/agent-paste-draft'
import { NATIVE_CHAT_SUBMIT_DELAY_MS } from '../../../../shared/native-chat-answer-stepping'
import {
  buildNativeChatImagePasteBytes,
  buildNativeChatPasteBytes,
  NATIVE_CHAT_SUBMIT
} from './native-chat-send'
import { enqueueNativeChatPtySend } from './native-chat-pty-send-queue'
import { formatImageDropPasteText } from '../terminal-pane/terminal-drop-image-path'
import { isTerminalDropWindowsPathLike } from '../terminal-pane/terminal-drop-shell'
import {
  clearConfirmDurationMs,
  clearThenWrite,
  clearUnsubmittedAgentInput,
  type NativeChatSendOptions
} from './native-chat-input-clear'
import { sendNativeChatMessage, type NativeChatSendHandle } from './native-chat-runtime-send'

export const NATIVE_CHAT_IMAGE_ATTACHMENT_SETTLE_MS = 300

type RuntimeSettings = ReturnType<typeof getSettingsForAgentTabRuntimeOwner>

/** The path text an agent detects as an image. One with spaces or shell characters is escaped as a
 *  terminal image drop is, which agent TUIs undo before checking the file exists. */
export function agentImagePastePath(agent: AgentType, path: string): string {
  const formatted = formatAgentImagePath(agent, path)
  if (formatted !== path) {
    return formatted
  }
  const targetShell = isTerminalDropWindowsPathLike(path) ? 'windows' : 'posix'
  return formatImageDropPasteText(path, targetShell) ?? path
}

export function sendNativeChatMessageWithImageAttachments(
  agent: AgentType,
  settings: RuntimeSettings,
  ptyId: string,
  text: string,
  imagePaths: readonly string[],
  options?: NativeChatSendOptions
): NativeChatSendHandle {
  if (imagePaths.length === 0) {
    return sendNativeChatMessage(settings, ptyId, text, options)
  }
  const trimmedText = text.trim()
  if (options?.onWriteRejected) {
    const writes = agentImagePasteWrites(
      agent,
      imagePaths.map((path) => buildNativeChatImagePasteBytes(agentImagePastePath(agent, path))),
      trimmedText.length > 0
    ).map((data) => ({ data, delayBeforeMs: 0 }))
    if (trimmedText) {
      writes.push({
        data: buildNativeChatPasteBytes(text),
        delayBeforeMs: NATIVE_CHAT_IMAGE_ATTACHMENT_SETTLE_MS
      })
    }
    writes.push({ data: NATIVE_CHAT_SUBMIT, delayBeforeMs: NATIVE_CHAT_SUBMIT_DELAY_MS })
    return sendNativeChatObservedWrites(settings, ptyId, writes, options)
  }
  const durationMs =
    (trimmedText.length > 0
      ? NATIVE_CHAT_IMAGE_ATTACHMENT_SETTLE_MS + NATIVE_CHAT_SUBMIT_DELAY_MS
      : NATIVE_CHAT_SUBMIT_DELAY_MS) + clearConfirmDurationMs(options)
  return enqueueNativeChatPtySend(
    ptyId,
    durationMs,
    ({ isCancelled, delay, markSubmitted }) => {
      if (isCancelled()) {
        return
      }
      clearThenWrite(settings, ptyId, options, delay, () => {
        if (isCancelled()) {
          return
        }
        for (const payload of agentImagePasteWrites(
          agent,
          imagePaths.map((path) =>
            buildNativeChatImagePasteBytes(agentImagePastePath(agent, path))
          ),
          trimmedText.length > 0
        )) {
          sendRuntimePtyInput(settings, ptyId, payload, 'driving')
        }
        if (trimmedText.length > 0) {
          delay(NATIVE_CHAT_IMAGE_ATTACHMENT_SETTLE_MS, () => {
            sendRuntimePtyInput(settings, ptyId, buildNativeChatPasteBytes(text), 'driving')
            delay(NATIVE_CHAT_SUBMIT_DELAY_MS, () => {
              sendRuntimePtyInput(settings, ptyId, NATIVE_CHAT_SUBMIT, 'driving')
              markSubmitted()
            })
          })
          return
        }
        delay(NATIVE_CHAT_SUBMIT_DELAY_MS, () => {
          sendRuntimePtyInput(settings, ptyId, NATIVE_CHAT_SUBMIT, 'driving')
          markSubmitted()
        })
      })
    },
    {
      onCancelUnsubmitted: () => clearUnsubmittedAgentInput(settings, ptyId, options)
    }
  )
}
