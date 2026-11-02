import type { TuiAgent } from './tui-agent'

/** The host runs generated input as one admitted transaction (terminal.sendGeneratedInput). */
export const GENERATED_INPUT_RUNTIME_CAPABILITY = 'terminal.generated-input.v1' as const

/** delivered/staged: written (prompt submitted / draft left unsubmitted). not-sent: no byte was
 *  written. unconfirmed: a frame may have been written, so it is never sent again automatically.
 *  target-gone: the terminal could not be resolved before any write. */
export type GeneratedInputOutcome =
  | 'delivered'
  | 'staged'
  | 'not-sent'
  | 'unconfirmed'
  | 'target-gone'

export type GeneratedInputRequest = {
  text: string
  submit: boolean
  agent?: TuiAgent | null
  timeoutMs?: number
  inputKind?: 'launch' | 'driving'
  /** startup waits for positive readiness; running (default) refuses only on blocking evidence. */
  intent?: 'startup' | 'running'
}

/** Text over one remote request's budget travels as ordered parts the host joins before admitting. */
export const GENERATED_INPUT_PART_MAX_CHARS = 96 * 1024

export function splitGeneratedInputText(text: string): string[] {
  const parts: string[] = []
  let offset = 0
  while (offset < text.length) {
    let end = Math.min(text.length, offset + GENERATED_INPUT_PART_MAX_CHARS)
    // Never split a surrogate pair across parts.
    if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1])) {
      end -= 1
    }
    parts.push(text.slice(offset, end))
    offset = end
  }
  return parts.length > 0 ? parts : ['']
}
