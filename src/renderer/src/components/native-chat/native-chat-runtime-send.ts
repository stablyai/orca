// Runtime send for native chat: writes the framed message body, then the Enter
// as a SEPARATE delayed pty write. Kept apart from the pure byte builders in
// native-chat-send.ts so those stay IO-free and unit-testable without aliases.

import { sendRuntimePtyInput } from '@/runtime/runtime-terminal-inspection'
import type { getSettingsForAgentTabRuntimeOwner } from '@/lib/agent-paste-draft'
import {
  buildNativeChatImagePasteBytes,
  buildNativeChatPasteBytes,
  NATIVE_CHAT_SUBMIT
} from './native-chat-send'

// Why: agent TUIs swallow a `\r` bundled into the same pty write as a framed
// paste, so a one-shot send leaves the text sitting in the input box, unsent.
// Write the body first, then the Enter after a delay so the agent processes the
// paste before the submit. The gap must clear the agent's paste-handling latency
// even while it's BUSY (Codex): a short gap (60ms) fires Enter before a busy
// Codex has landed the paste into its input, so the submit hits an empty box and
// the message sits "Queued" forever. 500ms is orca-runtime's proven value in
// writeTerminalAction({enter:true}), so match it here.
export const NATIVE_CHAT_SUBMIT_DELAY_MS = 500
export const NATIVE_CHAT_IMAGE_ATTACHMENT_SETTLE_MS = 300

// Why: Claude Code's AskUserQuestion is a MULTI-STEP prompt — it renders one
// question at a time and each Enter advances to the next (the final Enter
// submits the whole thing). After firing a question's Enter we must let the TUI
// render the next question before writing its body, or that body lands on the
// wrong (or no) active question. This buffer is added ON TOP of the body→Enter
// gap; a previous attempt that spaced Enters only ~350ms apart fired them faster
// than the next question rendered, leaking answers as fresh prompts. Kept
// generous so the next step still renders in time on slower machines / under SSH
// round-trip latency, where a tighter cadence misfires the answer.
export const NATIVE_CHAT_ADVANCE_BUFFER_MS = 500

/** Per-question wall-clock cadence: body→Enter gap plus the advance buffer that
 *  lets the next AskUserQuestion step render before its body is written. */
export const NATIVE_CHAT_QUESTION_STEP_MS =
  NATIVE_CHAT_SUBMIT_DELAY_MS + NATIVE_CHAT_ADVANCE_BUFFER_MS

/** Pure scheduling math for a per-question answer sequence. For question index
 *  `i` (0-based) returns the offsets (ms from the start of the send) at which to
 *  write its framed body and its Enter. Body for question 0 fires at 0; each
 *  later question starts a full step after the previous, so its body is never
 *  written until the previous question's Enter has fired plus the advance
 *  buffer. Exactly one Enter per question; the last Enter submits the prompt. */
export function nativeChatQuestionOffsets(index: number): {
  bodyAt: number
  enterAt: number
} {
  const bodyAt = index * NATIVE_CHAT_QUESTION_STEP_MS
  return { bodyAt, enterAt: bodyAt + NATIVE_CHAT_SUBMIT_DELAY_MS }
}

/** Cancels an in-flight send's pending pty writes (the delayed Enter, and any
 *  later question bodies/Enters). Safe to call after the send completes. */
export type NativeChatSendHandle = {
  cancel: () => void
  /** Time after which every scheduled write has fired and the handle can drop. */
  settleAfterMs: number
}

/**
 * Send a native-chat message through the verified runtime pty path: framed body
 * first, then a separate delayed Enter. `sendRuntimePtyInput` branches local
 * pty:write vs remote runtime RPC, so this works for SSH panes too. Returns a
 * cancel handle so callers can drop the still-pending Enter on unmount/stop.
 */
export function sendNativeChatMessage(
  settings: ReturnType<typeof getSettingsForAgentTabRuntimeOwner>,
  ptyId: string,
  text: string
): NativeChatSendHandle {
  sendRuntimePtyInput(settings, ptyId, buildNativeChatPasteBytes(text))
  const timer = setTimeout(() => {
    sendRuntimePtyInput(settings, ptyId, NATIVE_CHAT_SUBMIT)
  }, NATIVE_CHAT_SUBMIT_DELAY_MS)
  return { cancel: () => clearTimeout(timer), settleAfterMs: NATIVE_CHAT_SUBMIT_DELAY_MS }
}

export function sendNativeChatMessageWithImageAttachments(
  settings: ReturnType<typeof getSettingsForAgentTabRuntimeOwner>,
  ptyId: string,
  text: string,
  imagePaths: readonly string[]
): NativeChatSendHandle {
  if (imagePaths.length === 0) {
    return sendNativeChatMessage(settings, ptyId, text)
  }
  const timers: ReturnType<typeof setTimeout>[] = []
  for (const imagePath of imagePaths) {
    sendRuntimePtyInput(settings, ptyId, buildNativeChatImagePasteBytes(imagePath))
  }
  const trimmedText = text.trim()
  if (trimmedText.length > 0) {
    timers.push(
      setTimeout(() => {
        sendRuntimePtyInput(settings, ptyId, buildNativeChatPasteBytes(text))
      }, NATIVE_CHAT_IMAGE_ATTACHMENT_SETTLE_MS)
    )
  }
  timers.push(
    setTimeout(
      () => {
        sendRuntimePtyInput(settings, ptyId, NATIVE_CHAT_SUBMIT)
      },
      trimmedText.length > 0
        ? NATIVE_CHAT_IMAGE_ATTACHMENT_SETTLE_MS + NATIVE_CHAT_SUBMIT_DELAY_MS
        : NATIVE_CHAT_SUBMIT_DELAY_MS
    )
  )
  return {
    cancel: () => {
      for (const timer of timers) {
        clearTimeout(timer)
      }
    },
    settleAfterMs:
      trimmedText.length > 0
        ? NATIVE_CHAT_IMAGE_ATTACHMENT_SETTLE_MS + NATIVE_CHAT_SUBMIT_DELAY_MS
        : NATIVE_CHAT_SUBMIT_DELAY_MS
  }
}

/** Submit a TUI prompt with no body (Enter only) — e.g. a plain submit when the
 *  composer is empty. */
export function submitNativeChatPrompt(
  settings: ReturnType<typeof getSettingsForAgentTabRuntimeOwner>,
  ptyId: string
): void {
  sendRuntimePtyInput(settings, ptyId, NATIVE_CHAT_SUBMIT)
}

/**
 * Send an AskUserQuestion answer that may span multiple questions. Each line is
 * one question's answer (exactly how `formatAskAnswer` builds it). A single line
 * is just `sendNativeChatMessage` (no behavior change). For multiple lines we
 * write each question's framed body then its Enter as a per-question sequence,
 * paced by `NATIVE_CHAT_QUESTION_STEP_MS` so each Enter lands on its own
 * rendered question and the LAST Enter submits — exactly N Enters for N lines,
 * never a trailing one. Returns a cancel handle that clears every pending timer
 * so a detached sequence can't keep writing PTY bytes after unmount/stop.
 */
export function sendNativeChatAnswer(
  settings: ReturnType<typeof getSettingsForAgentTabRuntimeOwner>,
  ptyId: string,
  lines: string[]
): NativeChatSendHandle {
  if (lines.length <= 1) {
    return sendNativeChatMessage(settings, ptyId, lines[0] ?? '')
  }
  const timers: ReturnType<typeof setTimeout>[] = []
  lines.forEach((line, index) => {
    const { bodyAt, enterAt } = nativeChatQuestionOffsets(index)
    timers.push(
      setTimeout(() => {
        sendRuntimePtyInput(settings, ptyId, buildNativeChatPasteBytes(line))
      }, bodyAt)
    )
    timers.push(
      setTimeout(() => {
        sendRuntimePtyInput(settings, ptyId, NATIVE_CHAT_SUBMIT)
      }, enterAt)
    )
  })
  return {
    cancel: () => {
      for (const timer of timers) {
        clearTimeout(timer)
      }
    },
    settleAfterMs: nativeChatQuestionOffsets(lines.length - 1).enterAt
  }
}
