// A look's steps as Up next shows them while it runs: its connector reads named by place, any
// other tool call as the chat's own row would name it.
import type {
  NativeChatMessage,
  NativeChatToolCallBlock,
  NativeChatToolResultBlock
} from '../native-chat/native-chat-types'
import { pairToolBlocks } from '../native-chat/tools/native-chat-tool-pairs'
import { nativeChatFullCommand } from '../native-chat/tools/native-chat-tool-input-text'
import { suggestionLinkLabel, suggestionSource, type SuggestionSource } from './bot-look-around'

export type LookStepState = 'running' | 'done' | 'failed'

/** `position` is the step's place in the look, steady as later steps arrive. */
export type LookStep = { position: number } & (
  | {
      kind: 'read' | 'find' | 'check' | 'connections'
      /** The place or query as the owner would name it; empty for a Slack ref, which names no channel. */
      target: string
      source?: SuggestionSource
      /** A Slack ref to a thread, not a channel. */
      thread?: true
      state: LookStepState
    }
  | {
      kind: 'tool'
      call: NativeChatToolCallBlock
      result?: NativeChatToolResultBlock
      source?: SuggestionSource
      state: LookStepState
    }
)

/** A bot's commands name Orca's CLI through a shell default; the owner knows it as `orca`. */
export function withPlainOrcaCli(text: string): string {
  return text.replaceAll('"${ORCA_CLI_COMMAND:-orca}"', 'orca')
}

/** Shown while a look runs; older steps scroll off. */
export const LOOK_STEPS_SHOWN = 8

/** Flags that take a value, so the value isn't read as the place. */
const VALUE_FLAGS = new Set(['--limit', '--before'])

function shellWords(command: string): string[] {
  const words: string[] = []
  for (const match of command.matchAll(/"((?:\\.|[^"\\])*)"|'([^']*)'|(\S+)/g)) {
    words.push(match[1] ?? match[2] ?? match[3] ?? '')
  }
  return words
}

/** Where a Slack ref, link, Linear key or `owner/repo#12` lives, and its short name. */
function placeOf(place: string): { target: string; source?: SuggestionSource; thread?: true } {
  if (/^https?:\/\//i.test(place)) {
    const source = suggestionSource(place)
    return { target: suggestionLinkLabel(place), ...(source ? { source } : {}) }
  }
  if (place.startsWith('slack:')) {
    // A thread ref has a part past the channel.
    return {
      target: '',
      source: 'slack',
      ...(place.split(':').length > 3 ? { thread: true as const } : {})
    }
  }
  if (place.startsWith('#')) {
    return { target: place, source: 'slack' }
  }
  if (/^[A-Z][A-Z0-9]*-\d+$/.test(place)) {
    return { target: place, source: 'linear' }
  }
  const github = /^[\w.-]+\/([\w.-]+)#(\d+)$/.exec(place)
  return github ? { target: `${github[1]}#${github[2]}`, source: 'github' } : { target: place }
}

function connectorStep(
  command: string,
  state: LookStepState
): Omit<Extract<LookStep, { kind: 'read' | 'find' | 'check' | 'connections' }>, 'position'> | null {
  const words = shellWords(command)
  const at = words.indexOf('connector')
  if (at < 1 || !words.slice(0, at).some((word) => /orca/i.test(word))) {
    return null
  }
  const verb = words[at + 1]
  if (verb === 'capabilities' || verb === 'places') {
    return { kind: 'connections', target: '', state }
  }
  if (verb !== 'read' && verb !== 'find' && verb !== 'check') {
    return null
  }
  let place: string | undefined
  for (let index = at + 2; index < words.length && place === undefined; index++) {
    const word = words[index]
    if (VALUE_FLAGS.has(word)) {
      index++
    } else if (!word.startsWith('-')) {
      place = word
    }
  }
  if (place === undefined) {
    return null
  }
  return verb === 'find'
    ? { kind: 'find', target: place, state }
    : { kind: verb, ...placeOf(place), state }
}

/** The look's tool calls in order, each with its state from the call or its result. */
export function lookSteps(messages: readonly NativeChatMessage[]): LookStep[] {
  const pairs = pairToolBlocks(messages.flatMap((message) => message.blocks))
  const steps: LookStep[] = []
  for (const { call, result } of pairs) {
    if (!call) {
      continue
    }
    const state: LookStepState =
      call.state === 'failed' || result?.isError === true
        ? 'failed'
        : call.state === 'completed' || result !== undefined
          ? 'done'
          : 'running'
    const command = nativeChatFullCommand(call.input)
    const connector = command ? connectorStep(command, state) : null
    if (connector) {
      steps.push({ ...connector, position: steps.length })
      continue
    }
    const github = command !== null && /^gh\s/.test(command)
    steps.push({
      position: steps.length,
      kind: 'tool',
      call,
      ...(result ? { result } : {}),
      ...(github ? { source: 'github' as const } : {}),
      state
    })
  }
  return steps
}
