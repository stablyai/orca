/**
 * Size of the PTY output the renderer holds queued before xterm parses it.
 *
 * Why this is separate from the scrollback census: the backlog is a module-global
 * Map inside the output scheduler, not store state, so neither
 * summarizeStateCollectionSizes nor terminalLayoutsByTabId can see it. The cap is
 * per terminal (terminalOutputBacklogCapChars: 2MB at the default scrollback, 6MB
 * at 50k rows) and nothing bounds the aggregate, so N background terminals whose
 * PTYs keep writing while Chromium throttles their drain retain N x that cap in
 * plain JS strings — the exact growth shape an OOM highwater breadcrumb must name.
 *
 * The scheduler installs the reader because importing it here would pull the whole
 * pane-manager into the store chunk; registering from this leaf keeps the key
 * present (zeroed) even when no terminal ever loaded, so a missing key means the
 * instrument never ran rather than "no terminal output".
 */
import { registerRendererMemoryProfileContributor } from './renderer-memory-profile'

/** `chars`/`maxTerminalChars` are UTF-16 code units, not bytes — CJK and emoji
 *  under-report up to 3x. */
export type TerminalOutputBacklogCensus = {
  terminals: number
  chars: number
  maxTerminalChars: number
}

const EMPTY_CENSUS: TerminalOutputBacklogCensus = { terminals: 0, chars: 0, maxTerminalChars: 0 }

let readBacklog: (() => TerminalOutputBacklogCensus) | null = null

/** Installed by the output scheduler, which owns the queue. */
export function setTerminalOutputBacklogCensusReader(
  read: () => TerminalOutputBacklogCensus
): void {
  readBacklog = read
}

export function readTerminalOutputBacklogCensus(): TerminalOutputBacklogCensus {
  return readBacklog?.() ?? EMPTY_CENSUS
}

registerRendererMemoryProfileContributor('terminalOutputBacklog', readTerminalOutputBacklogCensus)
