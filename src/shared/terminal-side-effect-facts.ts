/** Main parses local/SSH PTY facts once on pty:sideEffect; renderer store policy decides notifications/unread state. */

import type { AgentIdleStatus } from './agent-title-status'
import type { ParsedAgentStatusPayload } from './agent-status-types'
import type { TerminalGitHubPRLink } from './terminal-github-pr-link-detector'

/** Timer stale-clears restore title/cache only; a >3s pause is not task completion and must not create unread/notification attention. */
export type TerminalSideEffectFact =
  | { kind: 'agent-status'; payload: ParsedAgentStatusPayload }
  | { kind: 'title'; normalizedTitle: string; rawTitle: string; staleWorkingTitleClear?: boolean }
  | { kind: 'bell' }
  | { kind: 'agent-working' }
  | {
      kind: 'agent-idle'
      title: string
      staleWorkingTitleClear?: boolean
      status?: AgentIdleStatus
    }
  | { kind: 'agent-exited' }
  /** OSC 133;D — foreground shell command exited (exit code best-effort). */
  | { kind: 'command-finished'; exitCode: number | null }
  /** Carry the parsed URL to avoid renderer parse drift breaking per-PTY dedupe. */
  | { kind: 'pr-link'; link: TerminalGitHubPRLink }
  /** Command Code lacks hooks: scrape working to seed status, but settle-check done against the live row before completing. */
  | { kind: 'command-code-working'; prompt: string }
  | { kind: 'command-code-done'; prompt: string }
  /** Gated views miss subscription bytes; carry state for later theme pushes, never an immediate reply. */
  | { kind: '2031-subscribe' }
  /** Gated views miss withdrawal bytes; retire their registry entry before a later theme flip. */
  | { kind: '2031-unsubscribe' }

export type TerminalSideEffectBatch = {
  ptyId: string
  /** Replay title sequence permits dropping state older than the latest applied live title. */
  seq: number
  /** Chunk facts contain agent status, titles and bell; Command Code scrape facts follow without affecting title/bell ordering. */
  facts: TerminalSideEffectFact[]
  /** True for (re)attach snapshots. Replay batches restore title state only —
   *  attention facts (bell, agent transitions) never replay. */
  replay?: boolean
  /** Main resolves attribution from runtime leaf/PTY bindings; absent until a binding is known. */
  worktreeId?: string
  tabId?: string
  paneKey?: string
  connectionId?: string | null
}
