// Shared host/command/plan notice presentation: desktop translates the copy; mobile renders it directly.

import {
  isAgentSessionHostStatusPresentation,
  type AgentSessionHostStatusPresentation
} from '../agent-session-host-status-rows'
import { AGENT_SESSION_ORCA_STOP_PRESENTATION } from '../agent-session-orca-stop'
import { NATIVE_CHAT_STOPPED_BEFORE_START_PRESENTATION } from './native-chat-stopped-before-start'
import type { NativeChatBlock, NativeChatTextBlock } from '../native-chat-types'

export const NATIVE_CHAT_NOTICE_COPY = {
  compaction: 'Context compacted',
  contextCleared: 'Context cleared',
  plan: 'Plan'
} as const

export type NativeChatNoticeTone = 'warning' | 'error' | 'notice'

export type NativeChatNoticeLook =
  /** A rule across the chat with its label. */
  | { kind: 'divider'; label: 'compaction' | 'contextCleared' }
  /** Laid out in columns, so drawn in monospace. */
  | { kind: 'command-output' }
  /** The host's line in the reader's words, drawn faint. */
  | { kind: 'host-status'; presentation: AgentSessionHostStatusPresentation }
  | { kind: 'plan' }
  /** Faint, as a system row with no notice of its own is. */
  | { kind: 'aside' }
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
  const { tone } = block
  return {
    kind: 'line',
    tone: tone === 'warning' || tone === 'error' || tone === 'notice' ? tone : null
  }
}
