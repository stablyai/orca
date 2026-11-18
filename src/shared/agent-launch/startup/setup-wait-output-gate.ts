import {
  SETUP_COMPLETE_MESSAGE,
  SETUP_FAILED_MESSAGE_PREFIX,
  SETUP_WAIT_MESSAGE,
  SETUP_WAIT_TIMEOUT_MESSAGE
} from './setup-agent-sequencing'

const SETUP_WAIT_END_LINES = [
  SETUP_COMPLETE_MESSAGE,
  SETUP_FAILED_MESSAGE_PREFIX,
  SETUP_WAIT_TIMEOUT_MESSAGE
]
const END_CARRY = Math.max(...SETUP_WAIT_END_LINES.map((line) => line.length)) - 1

export type SetupWaitPhase = 'waiting' | 'ended'

export type SetupWaitGate = {
  /** The chunk's agent output (none while Setup holds the pane) and the phase it entered, if any. */
  observe: (chunk: string) => { output: string; phase: SetupWaitPhase | null }
}

/** A wait-for-setup pane runs no agent between the sequenced wrapper's wait line and the line that ends it. */
export function createSetupWaitGate(): SetupWaitGate {
  let state: 'before' | SetupWaitPhase = 'before'
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
          carry = window.slice(-(SETUP_WAIT_MESSAGE.length - 1))
          return { output: chunk, phase: null }
        }
        state = phase = 'waiting'
        window = window.slice(at + SETUP_WAIT_MESSAGE.length)
      }
      let end: { at: number; length: number } | null = null
      for (const line of SETUP_WAIT_END_LINES) {
        const at = window.indexOf(line)
        if (at !== -1 && (!end || at < end.at)) {
          end = { at, length: line.length }
        }
      }
      if (!end) {
        carry = window.slice(-END_CARRY)
        return { output: '', phase }
      }
      state = 'ended'
      carry = ''
      return { output: window.slice(end.at + end.length), phase: 'ended' }
    }
  }
}
