/**
 * Derived terminal side-effect facts carried on the `pty:sideEffect` channel
 * (main → renderer). Events are facts, not decisions: main parses every
 * local-daemon/SSH PTY byte exactly once and emits what it observed; the
 * renderer store handler owns notification/unread policy.
 */

import type { TerminalGitHubPRLink } from './terminal-github-pr-link-detector'

/** Why tagged: stale-clear facts come from main's unthrottled 3s timer, not
 *  observed bytes. Renderer policy clears title/cache state from them but
 *  must not schedule task-complete notifications or unread attention — a
 *  merely-paused agent (>3s silent mid-task) is not a completion. */
export type TerminalSideEffectFact =
  | { kind: 'title'; normalizedTitle: string; rawTitle: string; staleWorkingTitleClear?: boolean }
  | { kind: 'bell' }
  | { kind: 'agent-working' }
  | { kind: 'agent-idle'; title: string; staleWorkingTitleClear?: boolean }
  | { kind: 'agent-exited' }
  /** OSC 133;D — foreground shell command exited (exit code best-effort). */
  | { kind: 'command-finished'; exitCode: number | null }
  /** Carries the parsed link so the renderer store consumer never re-parses
   *  the URL (parse drift would break the per-PTY dedupe contract). */
  | { kind: 'pr-link'; link: TerminalGitHubPRLink }
  /** Command Code output scrape (that CLI lacks hooks). Working seeds the
   *  agent-status row immediately; done is a hint the renderer settle-checks
   *  against its live status row before completing the turn. */
  | { kind: 'command-code-working'; prompt: string }
  | { kind: 'command-code-done'; prompt: string }
  /** DECSET 2031 color-scheme subscribe observed in the byte stream. Emitted
   *  so hidden-delivery-gated views (whose bytes never arrive) can still send
   *  the theme reply — the reply stays renderer-side because query authority
   *  belongs to the view (model/view contract invariant 6). */
  | { kind: '2031-subscribe' }

export type TerminalSideEffectBatch = {
  ptyId: string
  /** PTY output byte sequence at emission. Replay batches carry the sequence
   *  their title state was current at, so the handler can drop a replay title
   *  older than the last live title fact it applied. */
  seq: number
  /** Facts from one chunk, in byte order: titles in sequence, then bell.
   *  Command Code scrape facts trail the chunk's parser facts — their policy
   *  (status-row seeding) never interacts with title/bell ordering. */
  facts: TerminalSideEffectFact[]
  /** True for (re)attach snapshots. Replay batches restore title state only —
   *  attention facts (bell, agent transitions) never replay. */
  replay?: boolean
  /** Main-known attribution from runtime leaf/PTY records (same resolution as
   *  agent-status events). Absent when main has no binding for the PTY yet. */
  worktreeId?: string
  tabId?: string
  paneKey?: string
  connectionId?: string | null
}
