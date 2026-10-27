// Derive recall from the visible conversation at keypress so reloads, remounts and other clients’ sends need no separate history.

import { deriveNativeChatRowContent } from '../../../../shared/native-chat-row-content'
import { stripSentImagePromptMarkers } from '../../../../shared/native-chat-image-transcript-markers'
import { projectNativeChatTranscriptMessages } from '../../../../shared/native-chat-transcript-projection'
import type { NativeChatMessage } from '../../../../shared/native-chat-types'
import type { NativeChatCommandMarker } from './native-chat-command-marker'
import { compareMessages, orderMessages } from './native-chat-session-assembler'

export type NativeChatRecallSource = {
  messages: readonly NativeChatMessage[]
  /** Commands sent from this pane that the transcript holds no user turn for. */
  commands?: readonly NativeChatCommandMarker[]
  /** A structured chat's sends carry `[Image #k]` markers for images recall can't bring back. */
  withoutImageMarkers?: boolean
}

export type NativeChatSentPrompt = { id: string; prompt: string }

/** Everything the composer's keydown needs to recall; absent leaves the arrows to the caret. */
export type NativeChatComposerRecall = {
  source: NativeChatRecallSource
  position: NativeChatRecallPosition | null
  setPosition: (position: NativeChatRecallPosition | null) => void
  /** False keeps an arrow key moving the caret inside a recalled multi-line prompt. */
  isCaretOnVisualEdge: (edge: 'start' | 'end') => boolean
  /** Set the caret at keypress; relying on draft sync would preserve the previous prompt’s caret. */
  show: (prompt: string) => void
}

/** Stable ids survive incoming messages; editing the recalled text ends recall. */
export type NativeChatRecallPosition = { id: string; recalled: string }

export function isNativeChatRecallActive(
  position: NativeChatRecallPosition | null,
  draft: string
): position is NativeChatRecallPosition {
  return position !== null && position.recalled === draft
}

/** Oldest first. Text only: an images-only send has nothing to recall. */
export function nativeChatSentPrompts(source: NativeChatRecallSource): NativeChatSentPrompt[] {
  const prompts: NativeChatSentPrompt[] = []
  const push = (id: string, text: string): void => {
    const prompt = text.trim()
    if (prompt === '') {
      return
    }
    // A prompt repeated back to back is one stop, as in a shell's history.
    if (prompts.at(-1)?.prompt === prompt) {
      prompts.pop()
    }
    prompts.push({ id, prompt })
  }
  const commands = source.commands ?? []
  let nextCommand = 0
  // Use projected rows so harness turns and subagent prompts never enter user recall.
  for (const message of projectNativeChatTranscriptMessages(
    source.messages,
    compareMessages,
    orderMessages
  )) {
    // `from` marks a prompt another agent sent; it was never typed here.
    if (message.role !== 'user' || message.from) {
      continue
    }
    while (
      message.timestamp !== null &&
      nextCommand < commands.length &&
      commands[nextCommand].sentAt < message.timestamp
    ) {
      const command = commands[nextCommand++]
      push(`command:${command.id}`, command.command)
    }
    const text = deriveNativeChatRowContent(message.blocks).markdown
    push(
      message.id,
      source.withoutImageMarkers
        ? stripSentImagePromptMarkers(
            text,
            message.blocks.filter((block) => block.type === 'image-ref').length
          )
        : text
    )
  }
  for (const command of commands.slice(nextCommand)) {
    push(`command:${command.id}`, command.command)
  }
  return prompts
}

/** Start Back only from empty input; stop at the oldest prompt, clear past newest, and return null to leave the key to the caret. */
export function stepNativeChatPromptRecall(input: {
  direction: 'back' | 'forward'
  prompts: readonly NativeChatSentPrompt[]
  position: NativeChatRecallPosition | null
  draft: string
}): { position: NativeChatRecallPosition | null; draft: string } | null {
  const { prompts, position, draft } = input
  let active = -1
  if (isNativeChatRecallActive(position, draft)) {
    active = prompts.findIndex((prompt) => prompt.id === position.id)
    // An echo replaced by its transcript turn changes id but not text.
    if (active < 0) {
      active = prompts.findLastIndex((prompt) => prompt.prompt === position.recalled)
    }
  }
  if (active < 0 && (input.direction === 'forward' || draft !== '')) {
    return null
  }
  const next =
    input.direction === 'forward'
      ? prompts[active + 1]
      : prompts[active < 0 ? prompts.length - 1 : active - 1]
  if (next) {
    return { position: { id: next.id, recalled: next.prompt }, draft: next.prompt }
  }
  return input.direction === 'forward' ? { position: null, draft: '' } : null
}
