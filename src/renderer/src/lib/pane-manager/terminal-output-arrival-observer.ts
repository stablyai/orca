import type { TerminalOutputTarget } from './pane-terminal-output-queue-registry'

type TerminalOutputArrivalObserver = (terminal: TerminalOutputTarget) => void

let observer: TerminalOutputArrivalObserver | null = null

/** Diagnostic-only: lets the typing probe see output before scheduler queueing; unset costs one null check per write. */
export function setTerminalOutputArrivalObserver(next: TerminalOutputArrivalObserver | null): void {
  observer = next
}

export function noteTerminalOutputArrival(terminal: TerminalOutputTarget): void {
  observer?.(terminal)
}
