// Subagent roster, read from the transcript both clients already have.

import { agentJournalItemSubagentId } from '../../agent-session/journal/agent-session-journal-producer'
import type { NativeChatMessage, NativeChatSubagentState } from '../native-chat-types'
import { namedSubagents } from '../transcript/native-chat-subagent-items'
import {
  canReplaceSubagentState,
  isSubagentGroupFallbackText,
  normalizeSubagentState
} from '../transcript/native-chat-subagent-summary'
import { nativeChatToolSubagentActivities } from './native-chat-tool-subagents'

const ACTIVITY_LIMIT = 160

export type NativeChatSubagentActivity = {
  id: string
  label: string
  state: NativeChatSubagentState
  /** One capped line. The open child's latest message, else the parent's prompt or result. */
  activity: string | null
}

export function nativeChatSubagentActivities(
  conversation: readonly NativeChatMessage[],
  subagentRows: ReadonlyMap<string, readonly { message: NativeChatMessage }[]> = new Map(),
  seed: readonly NativeChatSubagentActivity[] | null = null
): NativeChatSubagentActivity[] {
  const order: string[] = []
  const known = new Map<
    string,
    { label: string; state: NativeChatSubagentState; activity: string | null }
  >()
  const note = (
    id: string,
    label: string,
    state: NativeChatSubagentState,
    activity: string | null = null
  ): void => {
    const current = known.get(id)
    if (!current) {
      order.push(id)
      known.set(id, { label: label.trim() || id, state, activity })
      return
    }
    known.set(id, {
      label: label.trim() || current.label,
      state: canReplaceSubagentState(current.state, state) ? state : current.state,
      activity: activity ?? current.activity
    })
  }
  for (const agent of seed ?? []) {
    note(agent.id, agent.label, agent.state, agent.activity)
  }
  // A tail that still holds the spawn must not walk a settled child back to working.
  // The full-file seed already holds the newest parent line. A tail that still shows the spawn must not replace it.
  for (const agent of nativeChatToolSubagentActivities(conversation)) {
    const held = known.get(agent.id)
    note(agent.id, agent.label, agent.state, held?.activity ? null : agent.activity)
  }
  for (const message of conversation) {
    for (const block of message.blocks) {
      for (const entry of namedSubagents(block)) {
        note(entry.id, entry.label, normalizeSubagentState(entry.state), entry.activity ?? null)
      }
    }
  }
  for (const [id, rows] of subagentRows) {
    if (known.has(id)) {
      continue
    }
    const state = rows.some((row) => row.message.state !== 'completed') ? 'working' : 'completed'
    note(id, id, state)
  }
  return order.map((id) => {
    const entry = known.get(id)!
    return {
      id,
      label: entry.label,
      state: entry.state,
      activity: latestActivity(subagentRows.get(id)) ?? entry.activity
    }
  })
}

/** Working covers pending and queued. Failed and unverifiable stay. Completed, idle, and cancelled leave. */
const LISTED_SUBAGENT_STATES: ReadonlySet<NativeChatSubagentState> = new Set([
  'working',
  'failed',
  'unverifiable'
])

export function nativeChatListedSubagents(
  subagents: readonly NativeChatSubagentActivity[]
): NativeChatSubagentActivity[] {
  return subagents.filter((agent) => LISTED_SUBAGENT_STATES.has(agent.state))
}

/** Messages one subagent produced, in transcript order. */
export function nativeChatSubagentMessages(
  messages: readonly NativeChatMessage[],
  agentId: string
): NativeChatMessage[] {
  return messages.filter((message) => agentJournalItemSubagentId(message) === agentId)
}

function latestActivity(
  rows: readonly { message: NativeChatMessage }[] | undefined
): string | null {
  if (!rows) {
    return null
  }
  for (let index = rows.length - 1; index >= 0; index--) {
    const line = activityLine(rows[index]!.message)
    if (line) {
      return line
    }
  }
  return null
}

function activityLine(message: NativeChatMessage): string | null {
  for (let index = message.blocks.length - 1; index >= 0; index--) {
    const block = message.blocks[index]
    if (!block) {
      continue
    }
    if (block.type === 'tool-call' && block.name.trim()) {
      return oneLine(block.name)
    }
    if (block.type === 'text') {
      const text = oneLine(block.text)
      if (!text || isRosterSentence(text)) {
        continue
      }
      return text
    }
  }
  return null
}

function isRosterSentence(text: string): boolean {
  return (
    isSubagentGroupFallbackText(text) ||
    text.startsWith('Kicked off subagent') ||
    text.startsWith('Ran subagent')
  )
}

function oneLine(text: string): string {
  const line = text.replace(/\s+/g, ' ').trim()
  return line.length > ACTIVITY_LIMIT ? `${line.slice(0, ACTIVITY_LIMIT - 1)}…` : line
}
