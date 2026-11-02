import type { TuiAgent } from './tui-agent'
import { TUI_AGENT_DISPLAY_NAMES } from './tui-agent-display-names'
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

// A UTF-16 unit costs at most 6 bytes once JSON-escaped, so a frame stays well under the 4 MiB
// paired-transport cap whatever the text; pages hold at most this many units across frames.
export const GENERATED_INPUT_NOTICE_CHUNK_UNITS = 96 * 1024
export const GENERATED_INPUT_NOTICE_PAGE_UNITS = 160 * 1024

/** End of the chunk starting at offset, never splitting a surrogate pair. */
export function generatedInputNoticeChunkEnd(text: string, offset: number, units: number): number {
  let end = Math.min(text.length, offset + Math.max(1, units))
  if (end < text.length && end - offset > 1 && /[\uD800-\uDBFF]/.test(text[end - 1])) {
    end -= 1
  }
  return end
}

export function generatedInputNoticeFrames(
  notice: GeneratedAgentInputNotice,
  from = 0,
  budgetUnits = Infinity
): { frames: GeneratedInputNoticeFrame[]; next: number | null } {
  const { text, ...meta } = notice
  const frames: GeneratedInputNoticeFrame[] = []
  let offset = from
  let spent = 0
  do {
    const units = Math.min(GENERATED_INPUT_NOTICE_CHUNK_UNITS, budgetUnits - spent)
    if (units <= 0) {
      return { frames, next: offset }
    }
    const end = generatedInputNoticeChunkEnd(text, offset, units)
    frames.push({ ...meta, textLength: text.length, offset, chunk: text.slice(offset, end) })
    spent += end - offset
    offset = end
  } while (offset < text.length)
  return { frames, next: null }
}

/** The agent's display name for notices and refusals; never a raw id. */
export function generatedInputAgentName(agent: string | null | undefined): string {
  return agent && agent in TUI_AGENT_DISPLAY_NAMES
    ? TUI_AGENT_DISPLAY_NAMES[agent as TuiAgent]
    : 'The agent'
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
