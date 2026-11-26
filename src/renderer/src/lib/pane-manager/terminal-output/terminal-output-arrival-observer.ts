import type { ForegroundTerminalOutputTarget } from './pane-terminal-foreground-render-settle'

type TerminalOutputArrivalObserver = (terminal: ForegroundTerminalOutputTarget) => void

let observer: TerminalOutputArrivalObserver | null = null

/** Diagnostic-only: lets the typing probe see output before scheduler queueing; unset costs one null check per write. */
export function setTerminalOutputArrivalObserver(next: TerminalOutputArrivalObserver | null): void {
  observer = next
}

export function noteTerminalOutputArrival(terminal: ForegroundTerminalOutputTarget): void {
  observer?.(terminal)
}
