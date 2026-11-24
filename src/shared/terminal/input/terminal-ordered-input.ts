import { getTerminalInputByteLength, TERMINAL_INPUT_MAX_BYTES } from './terminal-input'

export const TERMINAL_ORDERED_INPUT_CAPABILITY = 'terminal.ordered-input.v1'
export const TERMINAL_ORDERED_INPUT_WINDOW = 8
export const TERMINAL_ORDERED_INPUT_MAX_WAITERS = 128
export const TERMINAL_ORDERED_INPUT_MAX_BYTES = TERMINAL_INPUT_MAX_BYTES + 1024 * 1024
export const TERMINAL_ORDERED_INPUT_HOST_MAX_WAITERS = 512
export const TERMINAL_ORDERED_INPUT_HOST_MAX_BYTES = 64 * 1024 * 1024

export function terminalOrderedInputControls(params: { enter?: unknown; interrupt?: unknown }): {
  enter?: boolean
  interrupt?: boolean
} {
  return {
    ...(params.enter !== undefined ? { enter: params.enter === true } : {}),
    ...(params.interrupt !== undefined ? { interrupt: params.interrupt === true } : {})
  }
}

export function terminalOrderedInputByteLength(params: { text?: string }): number {
  const { text, ...metadata } = params
  if ((text?.length ?? 0) > TERMINAL_INPUT_MAX_BYTES) {
    return Infinity
  }
  try {
    return (
      getTerminalInputByteLength(text ?? '') + getTerminalInputByteLength(JSON.stringify(metadata))
    )
  } catch {
    return Infinity
  }
}

export type TerminalInputSessionBinding = {
  ptyId: string
  processIncarnation: string
  generation: number
}
