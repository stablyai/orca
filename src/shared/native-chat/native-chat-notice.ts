// Shared host/command/plan notice presentation: desktop translates the copy; mobile renders it directly.

import { readClaudeModelFallbackFrame } from './claude-model-fallback'
import { AGENT_SESSION_TURN_NOTICE_PRESENTATION } from '../agent-session/journal/agent-session-turn-notice'
import {
  isAgentSessionHostStatusPresentation,
  type AgentSessionHostStatusPresentation
} from '../agent-session/view/agent-session-host-status-rows'
import { AGENT_SESSION_ORCA_STOP_PRESENTATION } from '../agent-session/lifecycle/agent-session-orca-stop'
import { NATIVE_CHAT_STOPPED_BEFORE_START_PRESENTATION } from './native-chat-stopped-before-start'
import { AGENT_SESSION_FORKED_FROM_PRESENTATION } from '../agent-session/agent-session-fork'
import type { NativeChatBlock, NativeChatTextBlock } from './native-chat-types'

export const NATIVE_CHAT_NOTICE_COPY = {
  compaction: 'Context compacted',
  contextCleared: 'Context cleared',
  forkedFrom: 'Forked from',
  plan: 'Plan'
} as const

export type NativeChatNoticeTone = 'warning' | 'error' | 'notice'

export type NativeChatNoticeLook =
  /** A rule across the chat with its label. */
  | { kind: 'divider'; label: 'compaction' | 'contextCleared' }
  /** The rule after a fork's inherited history, naming the chat it came from. */
  | { kind: 'forked-from'; sourceSessionId: string; sourceName: string }
  /** Laid out in columns, so drawn in monospace. */
  | { kind: 'command-output' }
  /** The host's line in the reader's words, drawn faint. */
  | { kind: 'host-status'; presentation: AgentSessionHostStatusPresentation }
  | { kind: 'plan' }
  | { kind: 'model-fallback'; from: string; to: string }
  /** Faint, as a system row with no notice of its own is. */
  | { kind: 'aside' }
  | {
      kind: 'settled-permission'
      decision: 'safety-review' | 'denied'
      agent: 'Codex' | 'Claude'
      tone: 'warning' | 'error'
    }
  /** A boxed line with its icon when it has a tone; plain text when it has none. */
  | { kind: 'line'; tone: NativeChatNoticeTone | null }

/** The block a system row draws as its notice. A system row without one reads as a faint aside. */
export function nativeChatNoticeBlock(
  blocks: readonly NativeChatBlock[]
): NativeChatTextBlock | undefined {
  return blocks.find(
    (block): block is NativeChatTextBlock =>
      block.type === 'text' && (block.presentation !== undefined || block.tone !== undefined)
  )
}

export function nativeChatNoticeLook(block: NativeChatTextBlock): NativeChatNoticeLook {
  const { presentation } = block
  if (presentation === 'compaction') {
    return { kind: 'divider', label: 'compaction' }
  }
  if (presentation === 'context-cleared') {
    return { kind: 'divider', label: 'contextCleared' }
  }
  if (presentation === AGENT_SESSION_FORKED_FROM_PRESENTATION && block.forkedFrom) {
    return {
      kind: 'forked-from',
      sourceSessionId: block.forkedFrom.sessionId,
      sourceName: forkedFromSourceName(block.text)
    }
  }
  if (presentation === 'command-output') {
    return { kind: 'command-output' }
  }
  if (isAgentSessionHostStatusPresentation(presentation)) {
    return { kind: 'host-status', presentation }
  }
  if (presentation === 'plan-document') {
    return { kind: 'plan' }
  }
  if (presentation === NATIVE_CHAT_STOPPED_BEFORE_START_PRESENTATION) {
    return { kind: 'aside' }
  }
  // Orca stopped the reply, not the agent: stored red for clients that predate it, read as a notice.
  if (presentation === AGENT_SESSION_ORCA_STOP_PRESENTATION) {
    return { kind: 'line', tone: 'notice' }
  }
  const modelFallback =
    !block.failure &&
    !block.orcaStop &&
    (presentation === undefined || presentation === AGENT_SESSION_TURN_NOTICE_PRESENTATION) &&
    (block.tone === undefined || block.tone === 'notice')
      ? readClaudeModelFallbackFrame(block.providerFrame)
      : null
  if (modelFallback) {
    return { kind: 'model-fallback', ...modelFallback }
  }
  // Declared notification kinds select disclosure; prose and nested failures do not.
  if (presentation === undefined && !block.failure && !block.orcaStop) {
    const frame = block.providerFrame
    if (frame?.provider === 'codex' && frame.kind === 'notification:guardianWarning') {
      return {
        kind: 'settled-permission',
        decision: 'safety-review',
        agent: 'Codex',
        tone: 'warning'
      }
    }
    if (frame?.provider === 'claude' && frame.kind === 'message:system:permission_denied') {
      return { kind: 'settled-permission', decision: 'denied', agent: 'Claude', tone: 'error' }
    }
  }
  const { tone } = block
  return {
    kind: 'line',
    tone: tone === 'warning' || tone === 'error' || tone === 'notice' ? tone : null
  }
}

/** The host writes "Forked from <name>"; the name is what links to the source. */
function forkedFromSourceName(text: string): string {
  const lead = `${NATIVE_CHAT_NOTICE_COPY.forkedFrom} `
  return text.startsWith(lead) ? text.slice(lead.length) : text
}
