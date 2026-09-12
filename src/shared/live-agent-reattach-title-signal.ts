import type { AgentStatus } from './agent-title-core'
import { isCursorNativeAgentTitle } from './agent-title-core'
import { isOpenCodeNativeTitle } from './opencode-terminal-title'

/**
 * True for agent OSC titles that intentionally carry no working/idle glyph, so
 * detectAgentStatusFromTitle returns null for them by design.
 *
 * Cursor and OpenCode both own the live TUI after reattach; without this signal
 * POST_REPLAY_REATTACH_RESET disarms mouse tracking and wheel falls through to
 * shell/prompt history (#11123 OpenCode).
 */
export function isNativeStatuslessAgentReattachTitle(title: string): boolean {
  return isCursorNativeAgentTitle(title) || isOpenCodeNativeTitle(title)
}

/**
 * Whether a restored terminal title is strong enough to keep agent mouse/focus
 * modes on reattach.
 *
 * `detectedStatus` is injected so callers can pass the same detectAgentStatusFromTitle
 * binding they use elsewhere (renderer mocks stay consistent). Intentionally
 * narrower than getAgentLabel — token matches alone must not preserve modes.
 */
export function titleSignalsLiveAgentReattach(
  title: string,
  detectedStatus: AgentStatus | null
): boolean {
  return detectedStatus !== null || isNativeStatuslessAgentReattachTitle(title)
}
