// Grok records a child as spawn_subagent. Codex uses spawn_agent. Claude uses Agent or Task.

import {
  NATIVE_CHAT_SUBAGENT_STATES,
  type NativeChatMessage,
  type NativeChatSubagentState
} from '../native-chat-types'
import { foldToolMessages } from '../tools/native-chat-tool-fold'
import { pairToolBlocks } from '../tools/native-chat-tool-pairs'

export type NativeChatToolSubagent = {
  id: string
  label: string
  state: NativeChatSubagentState
  activity: string | null
}

const SPAWN_TOOLS = new Set(['spawnsubagent', 'spawnagent', 'agent', 'task'])
const LABEL_LIMIT = 80
const ACTIVITY_LIMIT = 160
const MAX_ACTIVITIES = 64
const SPAWN_ID = /subagent_id:\s*(\S+)/
const AGENT_ID = /agentId:\s*(\S+)/
const ACK_DESCRIPTION = /^description:\s*(.+)$/m
const SUBAGENT_COMMAND = /^Command: \[subagent(?::[^\]]*)?\]\s*(.*)$/m

function canonical(name: string): string {
  return name.trim().toLowerCase().replace(/[_-]/g, '')
}

function oneLine(text: string, limit: number): string {
  const line = text.replace(/\s+/g, ' ').trim()
  return line.length > limit ? `${line.slice(0, limit - 1)}…` : line
}

function record(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return null
  }
  return Object.fromEntries(Object.entries(value))
}

function isSubagentState(value: string): value is NativeChatSubagentState {
  return NATIVE_CHAT_SUBAGENT_STATES.some((state) => state === value)
}

function inputFields(input: unknown): Record<string, unknown> | null {
  if (typeof input === 'string') {
    try {
      return record(JSON.parse(input))
    } catch {
      return null
    }
  }
  return record(input)
}

function pathLabel(value: string): string {
  let label = value
  for (const part of value.split('/')) {
    if (part.length > 0) {
      label = part
    }
  }
  return label
}

function spawnLabel(input: unknown): string | null {
  const fields = inputFields(input)
  if (!fields) {
    return null
  }
  const description = typeof fields.description === 'string' ? fields.description.trim() : ''
  if (description) {
    return oneLine(description, LABEL_LIMIT)
  }
  const taskName = typeof fields.task_name === 'string' ? fields.task_name.trim() : ''
  if (taskName) {
    return oneLine(pathLabel(taskName), LABEL_LIMIT)
  }
  const prompt = typeof fields.prompt === 'string' ? fields.prompt.trim() : ''
  const line = prompt.split('\n')[0]?.trim() ?? ''
  return line ? oneLine(line, LABEL_LIMIT) : null
}

function outputFields(output: string | undefined): Record<string, unknown> | null {
  if (!output) {
    return null
  }
  try {
    return record(JSON.parse(output))
  } catch {
    return null
  }
}

function ackId(output: string | undefined): string | null {
  if (!output) {
    return null
  }
  const named = SPAWN_ID.exec(output)?.[1] ?? AGENT_ID.exec(output)?.[1]
  if (named) {
    return named
  }
  const taskName = outputFields(output)?.task_name
  return typeof taskName === 'string' && taskName.trim() ? taskName.trim() : null
}

function ackLabel(output: string | undefined): string | null {
  const line = output ? ACK_DESCRIPTION.exec(output)?.[1]?.trim() : undefined
  if (line) {
    return oneLine(line, LABEL_LIMIT)
  }
  const taskName = outputFields(output)?.task_name
  return typeof taskName === 'string' && taskName.includes('/')
    ? oneLine(pathLabel(taskName), LABEL_LIMIT)
    : null
}

function sectionState(status: string): NativeChatSubagentState | null {
  switch (status.toLowerCase()) {
    case 'completed':
    case 'success':
      return 'completed'
    case 'failed':
    case 'error':
      return 'failed'
    case 'cancelled':
    case 'canceled':
    case 'killed':
    case 'stopped':
      return 'stopped'
    case 'running':
    case 'pending':
    case 'in_progress':
      return 'working'
    default:
      return null
  }
}

function proseLine(body: string): string | null {
  const stripped = body
    .replace(/<subagent_meta>[\s\S]*?<\/subagent_meta>/g, '')
    .replace(/<subagent_result>[\s\S]*?<\/subagent_result>/g, '')
  for (const raw of stripped.split('\n')) {
    const line = raw.trim()
    if (
      !line ||
      line.startsWith('---') ||
      line.startsWith('===') ||
      line.startsWith('Command:') ||
      line.startsWith('Duration:') ||
      line.startsWith('Exit Code:') ||
      line.startsWith('<')
    ) {
      continue
    }
    return oneLine(line, ACTIVITY_LIMIT)
  }
  return null
}

/** Child agents named by spawn calls and later output reads. Shell tasks stay out. */
export function nativeChatToolSubagentActivities(
  messages: readonly NativeChatMessage[]
): NativeChatToolSubagent[] {
  const folded = foldToolMessages(messages)
  const order: string[] = []
  const known = new Map<string, NativeChatToolSubagent>()
  const note = (
    id: string,
    label: string,
    state: NativeChatSubagentState,
    activity: string | null
  ): void => {
    const current = known.get(id)
    if (!current) {
      order.push(id)
      known.set(id, { id, label: label || id, state, activity })
      return
    }
    known.set(id, {
      id,
      label: label || current.label,
      state,
      activity: activity ?? current.activity
    })
  }
  const applyOutput = (output: string): void => {
    const marks: { index: number; id: string; status: string }[] = []
    for (const match of output.matchAll(/--- Task (\S+) \[([A-Za-z_]+)\] ---/g)) {
      if (match[1] && match[2] && match.index !== undefined) {
        marks.push({ index: match.index, id: match[1], status: match[2] })
      }
    }
    for (let index = 0; index < marks.length; index += 1) {
      const mark = marks[index]!
      const body = output.slice(mark.index, marks[index + 1]?.index ?? output.length)
      const command = SUBAGENT_COMMAND.exec(body)
      // A shell wait uses the same task header. Only a subagent command, or a header for a child we spawned, counts.
      const otherCommand = !command && /^Command: /m.test(body)
      if (otherCommand || (!command && !known.has(mark.id))) {
        continue
      }
      const state = sectionState(mark.status)
      if (!state) {
        continue
      }
      const labelled = command?.[1]?.trim()
      note(mark.id, labelled ? oneLine(labelled, LABEL_LIMIT) : '', state, proseLine(body))
    }
  }
  let pending = 0
  for (const message of folded) {
    for (const pair of pairToolBlocks(message.blocks)) {
      const call = pair.call
      if (call && SPAWN_TOOLS.has(canonical(call.name))) {
        const failed = call.state === 'failed' || pair.result?.isError === true
        const id = ackId(pair.result?.output) ?? call.callId ?? `spawn:${message.id}:${pending}`
        pending += 1
        note(
          id,
          spawnLabel(call.input) ?? ackLabel(pair.result?.output) ?? '',
          failed ? 'failed' : 'working',
          null
        )
      }
      if (pair.result?.output) {
        applyOutput(pair.result.output)
      }
    }
  }
  const listed = order.map((id) => known.get(id)!)
  return listed.length > MAX_ACTIVITIES ? listed.slice(-MAX_ACTIVITIES) : listed
}

/** Drop a malformed seed instead of painting a pill from it. */
export function readNativeChatSubagentActivities(value: unknown): NativeChatToolSubagent[] | null {
  if (!Array.isArray(value)) {
    return null
  }
  const activities: NativeChatToolSubagent[] = []
  for (const entry of value) {
    const fields = record(entry)
    const id = typeof fields?.id === 'string' ? fields.id.trim() : ''
    const label = typeof fields?.label === 'string' ? fields.label.trim() : ''
    const state = typeof fields?.state === 'string' ? fields.state : ''
    if (!id || !label || !isSubagentState(state)) {
      return null
    }
    const activity = fields?.activity
    if (activity !== null && typeof activity !== 'string') {
      return null
    }
    activities.push({ id, label, state, activity })
  }
  return activities.length > 0 ? activities : null
}
