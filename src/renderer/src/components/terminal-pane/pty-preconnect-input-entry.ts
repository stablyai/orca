import type { PtyInputSource } from './pty-input-source'
import type { TerminalInputKind } from '../../../../shared/terminal-input-kind'

export type PtyPreconnectInputKind = 'ordinary' | 'immediate' | 'accepted'

/** Input retained while a pane waits for its first PTY connection. */
export type PtyPreconnectInputEntry = {
  data: string
  kind: PtyPreconnectInputKind
  inputKind: TerminalInputKind
  source?: PtyInputSource
}

/** Lets the caller of an acknowledged write give it up; a held or journaled copy is then never sent. */
export type AcceptedInputOptions = { signal?: AbortSignal }

export type BufferedInput = PtyPreconnectInputEntry & {
  resolve?: (accepted: boolean) => void
  signal?: AbortSignal
}

export type PreconnectInputWriter = {
  isCurrent: () => boolean
  sendInput: (data: string, inputKind: TerminalInputKind, source?: PtyInputSource) => boolean
  sendInputImmediate: (data: string, source?: PtyInputSource) => boolean
  sendInputAccepted?: (
    data: string,
    inputKind: TerminalInputKind,
    options?: AcceptedInputOptions,
    source?: PtyInputSource
  ) => Promise<boolean>
  /**
   * True when a failed accepted write was withdrawn or of unknown delivery, not a broken link, so
   * the input typed after it still goes (a sequenced remote stream keeps order on its own).
   */
  continuesAfterFailedWrite?: () => boolean
}
