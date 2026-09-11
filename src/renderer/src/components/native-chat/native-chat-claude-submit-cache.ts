import type { AgentType } from '../../../../shared/agent-status-types'
import {
  claudeSubmitBytesForGesture,
  resolveClaudeSubmitGesture,
  type ClaudeSubmitGesture
} from './native-chat-claude-submit-keybinding'

// The user's Claude submit gesture is global to their ~/.claude config, so read
// it once and cache the resolved gesture. Anything unresolved (not read yet, or
// the read failed) falls back to Enter — Claude's default and the safe choice.
let cachedGesture: ClaudeSubmitGesture | null = null
let priming = false

/** Kick off the one-time keybindings read. Idempotent; safe to call on every
 *  composer or comment-editor mount. */
export function primeClaudeSubmit(): void {
  if (cachedGesture !== null || priming) {
    return
  }
  const readKeybindings = window.api?.nativeChat?.readClaudeKeybindings
  if (!readKeybindings) {
    return
  }
  priming = true
  void readKeybindings()
    .then((content) => {
      cachedGesture = resolveClaudeSubmitGesture(content)
    })
    .catch(() => {
      cachedGesture = 'enter'
    })
    .finally(() => {
      priming = false
    })
}

/** Synchronous read; Enter until the keybindings load. */
export function getClaudeSubmitGesture(): ClaudeSubmitGesture {
  return cachedGesture ?? 'enter'
}

/** Submit bytes for the pty send path. */
export function getClaudeSubmitBytes(): string {
  return claudeSubmitBytesForGesture(getClaudeSubmitGesture())
}

/** Single source of truth for which agents resolve their submit gesture from a
 *  keybindings file. Only Claude reads `~/.claude/keybindings.json` today; a
 *  second agent becomes one more case here, not another scattered `=== 'claude'`. */
export function agentResolvesSubmitKeybinding(agent: AgentType): boolean {
  return agent === 'claude'
}

/** Kick off the keybindings read for agents that have one; no-op otherwise. */
export function primeComposerSubmitBytes(agent: AgentType): void {
  if (agentResolvesSubmitKeybinding(agent)) {
    primeClaudeSubmit()
  }
}

/** Which submit bytes a composer send should use: the agent's resolved gesture
 *  only for a LOCAL pane whose agent has a keybindings file, otherwise undefined
 *  so the send keeps its default CR. Other agents (their config isn't this file)
 *  and remote panes (their config lives on the host) are left untouched. */
export function resolveComposerSubmitBytes(
  agent: AgentType,
  isRemotePane: boolean
): string | undefined {
  if (!agentResolvesSubmitKeybinding(agent) || isRemotePane) {
    return undefined
  }
  // The send already defaults to Enter, so only override for a remapped gesture.
  // Leaving the default path untouched keeps every non-remapped user unaffected.
  const gesture = getClaudeSubmitGesture()
  return gesture === 'enter' ? undefined : claudeSubmitBytesForGesture(gesture)
}

export function resetClaudeSubmitBytesCacheForTests(): void {
  cachedGesture = null
  priming = false
}
