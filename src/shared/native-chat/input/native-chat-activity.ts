// Latest task list and subagent roster, read from the transcript both clients already have.
// A snapshot replaces the list. Grok merges todo_write by id. Claude's Task* tools edit one row.

import { agentJournalItemSubagentId } from '../../agent-session/journal/agent-session-journal-producer'
import type { NativeChatMessage, NativeChatSubagentState } from '../native-chat-types'
import { namedSubagents } from '../transcript/native-chat-subagent-items'
import {
  canReplaceSubagentState,
  isSubagentGroupFallbackText,
  normalizeSubagentState
} from '../transcript/native-chat-subagent-summary'
import { nativeChatToolSubagentActivities } from './native-chat-tool-subagents'
import { CODEX_PLAN_UPDATED_FRAME_KIND } from '../native-chat-provider-frame-summary'
import { pairToolBlocks } from '../tools/native-chat-tool-pairs'
import {
  applyNativeChatTaskListCall,
  normalizeNativeChatTaskList,
  readNativeChatTaskListCall,
  type NativeChatTask,
  type NativeChatTaskList,
  type NativeChatTaskStatus
} from './native-chat-task-list'
import {
  createNativeChatTaskBook,
  type NativeChatTaskBook,
  type NativeChatTaskSeedList
} from './native-chat-claude-task-updates'

const PLAN_CHECKBOX = /^- \[([ xX~-])\] (.*)$/
const PLAN_BULLET = /^(?:[-*]|\d+[.)])\s+(.+)$/
const ACTIVITY_LIMIT = 160

export type NativeChatSubagentActivity = {
  id: string
  label: string
  state: NativeChatSubagentState
  /** One capped line. The open child's latest message, else the parent's prompt or result. */
  activity: string | null
}

/** Checkbox lines the ACP plan update writes. A plan with no boxes uses its list items as pending tasks. */
export function nativeChatTaskListFromPlanDocument(text: string): NativeChatTaskList | null {
  const boxes: NativeChatTask[] = []
  const bullets: NativeChatTask[] = []
  let sawBox = false
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    const box = PLAN_CHECKBOX.exec(trimmed)
    if (box) {
      sawBox = true
      const content = box[2]?.trim()
      if (content) {
        boxes.push({ content, status: checkboxStatus(box[1]) })
      }
      continue
    }
    if (sawBox) {
      continue
    }
    const content = PLAN_BULLET.exec(trimmed)?.[1]?.trim()
    if (content) {
      bullets.push({ content, status: 'pending' })
    }
  }
  if (sawBox) {
    return { tasks: boxes }
  }
  return bullets.length > 0 ? { tasks: bullets } : null
}

function checkboxStatus(mark: string | undefined): NativeChatTaskStatus {
  if (mark === 'x' || mark === 'X') {
    return 'completed'
  }
  if (mark === '~') {
    return 'in_progress'
  }
  if (mark === '-') {
    return 'cancelled'
  }
  return 'pending'
}

/** The list as of the last accepted update. A seed is the history outside this window. */
export function latestNativeChatTaskList(
  messages: readonly NativeChatMessage[],
  seed?: NativeChatTaskSeedList | null
): NativeChatTaskList | null {
  return fillTaskBook(messages, seed).list()
}

/** Same list, keeping provider ids so a later TaskUpdate edits the row instead of adding one. */
export function latestNativeChatTaskSeed(
  messages: readonly NativeChatMessage[]
): NativeChatTaskSeedList | null {
  const seed = fillTaskBook(messages).seed()
  return seed && seed.tasks.length > 0 ? seed : null
}

function fillTaskBook(
  messages: readonly NativeChatMessage[],
  seed?: NativeChatTaskSeedList | null
): NativeChatTaskBook {
  const book = createNativeChatTaskBook()
  if (seed && seed.tasks.length > 0) {
    book.replace(seed)
  }
  for (const message of messages) {
    const pairs = new Map(
      pairToolBlocks(message.blocks).flatMap((pair) =>
        pair.call ? [[pair.call, pair] as const] : []
      )
    )
    for (const block of message.blocks) {
      if (block.type === 'text') {
        if (block.presentation === 'plan-document') {
          const plan = nativeChatTaskListFromPlanDocument(block.text)
          if (plan) {
            book.replace(plan)
          }
        }
        const frame = block.providerFrame
        if (frame?.kind === CODEX_PLAN_UPDATED_FRAME_KIND && !frame.payload.truncated) {
          const plan = normalizeNativeChatTaskList('update_plan', frame.payload.head)
          if (plan) {
            book.replace(plan)
          }
        }
        continue
      }
      if (block.type !== 'tool-call') {
        continue
      }
      const pair = pairs.get(block)
      if (!pair?.call || pair.call.state === 'failed' || pair.result?.isError) {
        continue
      }
      const call = readNativeChatTaskListCall(pair.call.name, pair.call.input)
      if (call) {
        const next = applyNativeChatTaskListCall(book.seed(), call)
        if (next) {
          book.replace(next)
        }
        continue
      }
      book.applyClaude(pair.call.name, pair.call.input, pair.result?.output)
    }
  }
  return book
}

/** The open transcript's own list, or the main plan when that transcript has none. */
export function nativeChatVisibleTaskList(
  sessionMessages: readonly NativeChatMessage[],
  focusedMessages: readonly NativeChatMessage[] | null,
  sessionSeed?: NativeChatTaskSeedList | null
): NativeChatTaskList | null {
  if (focusedMessages) {
    const focused = latestNativeChatTaskList(focusedMessages)
    if (focused && focused.tasks.length > 0) {
      return focused
    }
  }
  return latestNativeChatTaskList(sessionMessages, sessionSeed)
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
