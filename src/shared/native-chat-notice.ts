// How a chat draws a row the agent did not write in its own words: compaction and clear markers,
// command output, host status, plans, and warnings or errors. Desktop translates these words (they
// are its fallbacks); the phone shows them as they are.

import {
  isAgentSessionHostStatusPresentation,
  type AgentSessionHostStatusPresentation
} from './agent-session-host-status-rows'
import { AGENT_SESSION_ORCA_STOP_PRESENTATION } from './agent-session-orca-stop'
import { NATIVE_CHAT_STOPPED_BEFORE_START_PRESENTATION } from './native-chat-stopped-before-start'
import type { NativeChatBlock, NativeChatTextBlock } from './native-chat-types'

export const NATIVE_CHAT_NOTICE_COPY = {
  compaction: 'Context compacted',
  contextCleared: 'Context cleared',
  plan: 'Plan',
  configuration: 'Codex configuration warning',
  deprecation: 'Codex deprecation notice',
  retrying: 'Retrying',
  retryAttempt: 'Retrying · {{attempt}}',
  retryAttemptOf: 'Retrying · {{attempt}} of {{maxRetries}}'
} as const

export type NativeChatNoticeTone = 'warning' | 'error' | 'notice'

export type NativeChatNoticeDisclosureLook = {
  kind: 'disclosure'
  label: 'configuration' | 'deprecation' | 'retrying'
  attempt?: number
  maxRetries?: number
}

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
  | NativeChatNoticeDisclosureLook
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
  if (presentation === undefined && block.orcaStop === undefined) {
    if (block.failure?.kind === 'providerRetrying') {
      return {
        kind: 'disclosure',
        label: 'retrying',
        attempt: block.failure.retry?.attempt,
        maxRetries: block.failure.retry?.maxRetries
      }
    }
    if (!block.failure && block.tone !== 'error' && block.providerFrame?.provider === 'codex') {
      if (block.providerFrame.kind === 'notification:configWarning') {
        return { kind: 'disclosure', label: 'configuration' }
      }
      if (block.providerFrame.kind === 'notification:deprecationNotice') {
        return { kind: 'disclosure', label: 'deprecation' }
      }
    }
  }
  const { tone } = block
  return {
    kind: 'line',
    tone: tone === 'warning' || tone === 'error' || tone === 'notice' ? tone : null
  }
}

export function nativeChatNoticeDisclosureKey(messageId: string): string {
  return `notice:${messageId}`
}

export function nativeChatNoticeDisclosureText(look: NativeChatNoticeDisclosureLook): string {
  if (look.label !== 'retrying' || !look.attempt) {
    return NATIVE_CHAT_NOTICE_COPY[look.label]
  }
  return (
    look.maxRetries ? NATIVE_CHAT_NOTICE_COPY.retryAttemptOf : NATIVE_CHAT_NOTICE_COPY.retryAttempt
  )
    .replace('{{attempt}}', String(look.attempt))
    .replace('{{maxRetries}}', String(look.maxRetries))
}
