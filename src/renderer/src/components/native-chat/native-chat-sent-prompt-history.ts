// Terminal-style prompt recall: Up/Down in the composer walk what the chat shows the
// user sent. Derived from the shown conversation at the keypress, so there is no
// history to store, and recall survives a remount, a reload, and another client's sends.

import { deriveNativeChatRowContent } from '../../../../shared/native-chat-row-content'
import { projectNativeChatTranscriptMessages } from '../../../../shared/native-chat-transcript-projection'
import type { NativeChatMessage } from '../../../../shared/native-chat-types'
import type { NativeChatCommandMarker } from './native-chat-command-marker'
import { compareMessages } from './native-chat-session-assembler'

/** The conversation a composer recalls from. */
export type NativeChatRecallSource = {
  messages: readonly NativeChatMessage[]
  /** Commands sent from this pane that the transcript holds no user turn for. */
  commands?: readonly NativeChatCommandMarker[]
}

export type NativeChatSentPrompt = { id: string; prompt: string }

/** Everything the composer's keydown needs to recall; absent leaves the arrows to the caret. */
export type NativeChatComposerRecall = {
  source: NativeChatRecallSource
  position: NativeChatRecallPosition | null
  setPosition: (position: NativeChatRecallPosition | null) => void
  /** False keeps an arrow key moving the caret inside a recalled multi-line prompt. */
  isCaretOnVisualEdge: (edge: 'start' | 'end') => boolean
  /** Puts a recalled prompt in the editor with the caret at its end, as a shell does. Done at
   *  the keypress: left to the draft sync, the caret stays wherever the last prompt had it. */
  show: (prompt: string) => void
}

/** `id` survives new messages landing mid-recall; `recalled` is the text put in the
 *  composer, and recall is over once the composer no longer holds it. */
export type NativeChatRecallPosition = { id: string; recalled: string }

/** Recall is live only while the composer still holds the recalled text untouched. */
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
  // Why projected: the raw list also holds harness-injected user turns and subagent prompts,
  // which the chat never draws as the user's own.
  for (const message of projectNativeChatTranscriptMessages(source.messages, compareMessages)) {
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
    push(message.id, deriveNativeChatRowContent(message.blocks).markdown)
  }
  for (const command of commands.slice(nextCommand)) {
    push(`command:${command.id}`, command.command)
  }
  return prompts
}

/**
 * One Up (`back`) or Down (`forward`) press. Null leaves the key to the caret. Back starts
 * only from an empty composer and stops at the oldest prompt; forward past the newest
 * empties the composer and ends recall.
 */
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
