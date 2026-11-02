import type { TuiAgent } from './tui-agent'
import { TUI_AGENT_DISPLAY_NAMES } from './tui-agent-display-names'
import { isTuiAgent } from './tui-agent-config'
import type { GeneratedInputOutcome } from './generated-terminal-input'

/** Runtime-session notices recover generated text whose detached delivery failed. */
export type GeneratedAgentInputNotice = {
  id: string
  agent: TuiAgent
  text: string
  handle: string
  worktreeId: string
  ptyId: string | null
  certainty: 'not-sent' | 'unconfirmed'
  /** False for an unsubmitted draft, which keeps the notes wording; absent means a prompt. */
  submitted?: boolean
}

/** One ordered slice of a notice's exact text, with the notice's metadata. */
export type GeneratedInputNoticeFrame = Omit<GeneratedAgentInputNotice, 'text'> & {
  textLength: number
  offset: number
  chunk: string
}

export type GeneratedInputNoticeStreamMessage =
  | { type: 'ready'; subscriptionId: string; session: string; revision: number }
  | { type: 'notice'; session: string; revision: number; frame: GeneratedInputNoticeFrame }
  | { type: 'dismissed'; session: string; revision: number; id: string }
  | { type: 'end' }

export type GeneratedInputNoticesPage = {
  session: string
  revision: number
  frames: GeneratedInputNoticeFrame[]
  next: { cursor: number; offset: number } | null
}

// A UTF-16 unit costs at most 6 bytes once JSON-escaped. A live frame holds at most this many
// units; a snapshot page is bounded by the encoded bytes of every frame in it, metadata included,
// far under the 4 MiB paired-transport cap however many notices or however large the text.
export const GENERATED_INPUT_NOTICE_CHUNK_UNITS = 96 * 1024
export const GENERATED_INPUT_NOTICE_PAGE_BYTES = 1024 * 1024
// Room for the page envelope and a frame's offset digits beyond the measured metadata.
const FRAME_SLACK_BYTES = 64

const encoder = new TextEncoder()
export function encodedJsonBytes(value: unknown): number {
  return encoder.encode(JSON.stringify(value)).length
}

/** End of the chunk starting at offset, never splitting a surrogate pair. */
export function generatedInputNoticeChunkEnd(text: string, offset: number, units: number): number {
  let end = Math.min(text.length, offset + Math.max(1, units))
  if (end < text.length && end - offset > 1 && /[\uD800-\uDBFF]/.test(text[end - 1])) {
    end -= 1
  }
  return end
}

/** Ordered frames of one notice from `from`, within `budgetBytes` of encoded JSON. `next` is the
 *  offset to resume at when the budget ran out first. */
export function generatedInputNoticeFrames(
  notice: GeneratedAgentInputNotice,
  from = 0,
  budgetBytes = Infinity
): { frames: GeneratedInputNoticeFrame[]; next: number | null; bytes: number } {
  const { text, ...meta } = notice
  const metaBytes =
    encodedJsonBytes({ ...meta, textLength: text.length, offset: 0, chunk: '' }) + FRAME_SLACK_BYTES
  const frames: GeneratedInputNoticeFrame[] = []
  let offset = from
  let bytes = 0
  do {
    const room = budgetBytes - bytes - metaBytes
    const units = Math.min(GENERATED_INPUT_NOTICE_CHUNK_UNITS, Math.floor(room / 6))
    if (room < 0 || (units < 1 && offset < text.length)) {
      return { frames, next: offset, bytes }
    }
    const end = units < 1 ? offset : generatedInputNoticeChunkEnd(text, offset, units)
    frames.push({ ...meta, textLength: text.length, offset, chunk: text.slice(offset, end) })
    bytes += metaBytes + (end - offset) * 6
    offset = end
  } while (offset < text.length)
  return { frames, next: null, bytes }
}

/** The agent's display name for notices and refusals; never a raw id. */
export function generatedInputAgentName(agent: string | null | undefined): string {
  return agent && isTuiAgent(agent) ? TUI_AGENT_DISPLAY_NAMES[agent] : 'The agent'
}

/** Why a reused automation session's run failed instead of starting a second session. */
export function reusedAutomationPromptRefusal(
  agent: string,
  outcome: GeneratedInputOutcome
): string {
  const name = generatedInputAgentName(agent)
  return outcome === 'unconfirmed'
    ? `${name} may have received part of the automation prompt. Check its terminal before running this automation again.`
    : `${name} didn't take the automation prompt, so it wasn't sent. Answer any dialog in its terminal, then run this automation again.`
}
