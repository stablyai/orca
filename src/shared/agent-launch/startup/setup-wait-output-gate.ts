import {
  SETUP_AGENT_WAIT_TIMEOUT_SECONDS,
  SETUP_COMPLETE_MESSAGE,
  SETUP_FAILED_MESSAGE_PREFIX,
  SETUP_WAIT_MESSAGE,
  SETUP_WAIT_TIMEOUT_MESSAGE
} from './setup-agent-sequencing'
import { copyUtf16SuffixToOwnedString } from '../../text/owned-utf16-suffix'

/** The wrapper itself gives up then, so no agent can start after it. */
export const SETUP_WAIT_GATE_MAX_MS = SETUP_AGENT_WAIT_TIMEOUT_SECONDS * 1000

const SETUP_WAIT_END_LINES: readonly { line: string; phase: 'started' | 'failed' }[] = [
  { line: SETUP_COMPLETE_MESSAGE, phase: 'started' },
  { line: SETUP_FAILED_MESSAGE_PREFIX, phase: 'failed' },
  { line: SETUP_WAIT_TIMEOUT_MESSAGE, phase: 'failed' }
]
const END_CARRY = Math.max(...SETUP_WAIT_END_LINES.map(({ line }) => line.length)) - 1

/** `started`: the agent runs from here; `failed`: Setup failed or timed out, so no agent will. */
export type SetupWaitPhase = 'waiting' | 'started' | 'failed'

export type SetupWaitGate = {
  /** The chunk's agent output (none while Setup holds the pane) and the phase it entered, if any. */
  observe: (chunk: string) => { output: string; phase: SetupWaitPhase | null }
}

/** A wait-for-setup pane runs no agent between the sequenced wrapper's wait line and the line that ends it. */
export function createSetupWaitGate(): SetupWaitGate {
  let state: 'before' | 'waiting' | 'ended' = 'before'
  let carry = ''
  return {
    observe: (chunk) => {
      if (state === 'ended') {
        return { output: chunk, phase: null }
      }
      let window = carry + chunk
      let phase: SetupWaitPhase | null = null
      if (state === 'before') {
        const at = window.indexOf(SETUP_WAIT_MESSAGE)
        if (at === -1) {
          carry = copyUtf16SuffixToOwnedString(window, SETUP_WAIT_MESSAGE.length - 1)
          return { output: chunk, phase: null }
        }
        state = phase = 'waiting'
        window = window.slice(at + SETUP_WAIT_MESSAGE.length)
      }
      let end: { at: number; length: number; phase: 'started' | 'failed' } | null = null
      for (const { line, phase: endPhase } of SETUP_WAIT_END_LINES) {
        const at = window.indexOf(line)
        if (at !== -1 && (!end || at < end.at)) {
          end = { at, length: line.length, phase: endPhase }
        }
      }
      if (!end) {
        carry = copyUtf16SuffixToOwnedString(window, END_CARRY)
        return { output: '', phase }
      }
      state = 'ended'
      carry = ''
      return { output: window.slice(end.at + end.length), phase: end.phase }
    }
  }
}
