// The AgentSessionEvent members that are neither turn-lifecycle frames nor
// their own typed side channel. Shared because the classification is wire
// knowledge: main routes on it, the renderer projects from it.
//
// Canonical list: packages/coding-agent/src/session/agent-session-events.ts
// (the members AgentSessionEvent adds on top of core AgentEvent), plus
// `extension_error`, which rpc.md documents as a separately emitted session
// frame. Routing them to `session-event` rather than `unknown-frame` is what
// makes the distinction meaningful: `unknown-frame` means "OMP emitted
// something this build has never heard of", which is a diagnostic signal, while
// these are documented session facts Orca simply does not render yet. Without
// this split every new OMP release would look like a protocol surprise.

import type { OmpRpcUnknownFrame } from './omp-rpc-protocol'

export const OMP_RPC_SESSION_EVENT_TYPES: ReadonlySet<string> = new Set([
  'auto_compaction_start',
  'auto_compaction_end',
  'auto_retry_start',
  'auto_retry_end',
  'retry_fallback_applied',
  'retry_fallback_succeeded',
  'model_changed',
  'config_warnings_changed',
  'advisor_cost_changed',
  'ttsr_triggered',
  'todo_reminder',
  'todo_auto_clear',
  'irc_message',
  'notice',
  'thinking_level_changed',
  'goal_updated',
  'extension_error'
])

export function isOmpRpcSessionEventFrame(frame: { type: string }): boolean {
  return OMP_RPC_SESSION_EVENT_TYPES.has(frame.type)
}

/** `thinking_level_changed` is the one session event whose payload names state
 *  the pane already renders (`config_update`'s thinking level). `thinkingLevel`
 *  is `ThinkingLevel | undefined` upstream, so an absent field means "unknown",
 *  not "cleared" — the reducer keeps the last known value, exactly as it does
 *  for a bare `config_update`. */
export function readOmpRpcThinkingLevelChanged(
  frame: OmpRpcUnknownFrame
): { thinkingLevel: string | null } | null {
  if (frame.type !== 'thinking_level_changed') {
    return null
  }
  return { thinkingLevel: typeof frame.thinkingLevel === 'string' ? frame.thinkingLevel : null }
}
