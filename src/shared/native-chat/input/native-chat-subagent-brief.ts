// The child page is the activity. The task the parent handed over, and a result that
// never landed in the child file, are framed around it.

import type { NativeChatMessage, NativeChatToolResultBlock } from '../native-chat-types'
import { foldToolMessages } from '../tools/native-chat-tool-fold'
import { pairToolBlocks } from '../tools/native-chat-tool-pairs'

const SPAWN_TOOLS = new Set(['spawnsubagent', 'spawnagent', 'agent', 'task'])
const SPAWN_ID = /subagent_id:\s*(\S+)/
const AGENT_ID = /agentId:\s*(\S+)/

export type NativeChatSubagentBrief = {
  id: string
  title: string
  prompt: string
  result: string | null
}

export type NativeChatSubagentBriefFallback = {
  title: string
  prompt: string | null
}

function canonical(name: string): string {
  return name.trim().toLowerCase().replace(/[_-]/g, '')
}

function record(value: unknown): Record<string, unknown> | null {
  if (typeof value === 'string') {
    try {
      return record(JSON.parse(value) as unknown)
    } catch {
      return null
    }
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return null
  }
  return Object.fromEntries(Object.entries(value))
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

/** Ciphertext is not a task the reader can use. */
function readable(value: unknown): string {
  if (typeof value !== 'string') {
    return ''
  }
  const text = value.trim()
  if (!text || text.startsWith('gAAAAA') || text.includes('encrypted_content')) {
    return ''
  }
  return text
}

function ackId(output: string | undefined): string | null {
  if (!output) {
    return null
  }
  const named = SPAWN_ID.exec(output)?.[1] ?? AGENT_ID.exec(output)?.[1]
  if (named) {
    return named
  }
  const taskName = record(output)?.task_name
  return typeof taskName === 'string' && taskName.trim() ? taskName.trim() : null
}

function launchAck(output: string): boolean {
  if (/async agent launched/i.test(output)) {
    return true
  }
  const fields = record(output)
  if (fields && Object.keys(fields).every((key) => key === 'task_name')) {
    return true
  }
  return output.length < 240 && /agentId:/.test(output) && /launched/i.test(output)
}

/** The harness wraps the report. The disclaimer and usage footer are not the result. */
function handbackReport(output: string): string | null {
  if (!output.includes('[Subagent hand-back]')) {
    return null
  }
  const marker = 'The report follows:'
  const at = output.indexOf(marker)
  if (at === -1) {
    return ''
  }
  let body = output.slice(at + marker.length)
  const end = body.search(/\nagentId:|\n<usage>/)
  if (end !== -1) {
    body = body.slice(0, end)
  }
  return body
    .split('\n')
    .map((line) => (line.startsWith('  ') ? line.slice(2) : line))
    .join('\n')
    .trim()
}

function visibleResult(output: string): string | null {
  if (!output || launchAck(output)) {
    return null
  }
  const report = handbackReport(output)
  if (report !== null) {
    return report || null
  }
  return output
}

export function nativeChatSpawnedSubagentId(
  name: string,
  result: Pick<NativeChatToolResultBlock, 'output' | 'subagent'> | undefined
): string | null {
  if (!SPAWN_TOOLS.has(canonical(name))) {
    return null
  }
  const settled = result?.subagent?.id.trim()
  if (settled) {
    return settled
  }
  return ackId(result?.output)
}

export function nativeChatSubagentCallTitle(input: unknown, fallback: string): string {
  const fields = record(input)
  const description = readable(fields?.description)
  if (description) {
    return description
  }
  const taskName = readable(fields?.task_name)
  return taskName ? pathLabel(taskName) : fallback
}

export function nativeChatSubagentBriefs(
  messages: readonly NativeChatMessage[]
): Map<string, NativeChatSubagentBrief> {
  const briefs = new Map<string, NativeChatSubagentBrief>()
  for (const message of foldToolMessages(messages)) {
    for (const pair of pairToolBlocks(message.blocks)) {
      const call = pair.call
      if (!call) {
        continue
      }
      const id = nativeChatSpawnedSubagentId(call.name, pair.result)
      if (!id) {
        continue
      }
      const fields = record(call.input)
      const description = readable(fields?.description)
      const taskName = readable(fields?.task_name)
      const title = description || (taskName ? pathLabel(taskName) : '')
      const prompt = readable(fields?.prompt) || readable(fields?.message)
      const result = visibleResult(pair.result?.output?.trim() ?? '')
      const current = briefs.get(id)
      briefs.set(id, {
        id,
        title: title || current?.title || '',
        prompt: prompt || current?.prompt || '',
        result: result ?? current?.result ?? null
      })
    }
  }
  return briefs
}

function textOf(message: NativeChatMessage): string {
  return message.blocks
    .flatMap((block) => (block.type === 'text' ? [block.text] : []))
    .join('\n')
    .trim()
}

function echoedSpawn(message: NativeChatMessage): boolean {
  const blocks = message.blocks.filter((block) => block.type !== 'tool-result')
  return (
    blocks.length > 0 &&
    blocks.every((block) => block.type === 'tool-call' && SPAWN_TOOLS.has(canonical(block.name)))
  )
}

function taskBody(title: string, prompt: string): string {
  if (title && prompt && !prompt.includes(title)) {
    return `${title}\n\n${prompt}`
  }
  return prompt || title
}

function missingTask(firstText: string, title: string, prompt: string): string {
  // A sealed spawn has no prompt. The roster line is the child's output, so the title stands alone.
  if (!prompt) {
    return title && firstText.trim() !== title ? title : ''
  }
  const promptShown = firstText.includes(prompt.slice(0, Math.min(80, prompt.length)))
  const titleShown = title.length === 0 || firstText.includes(title)
  if (promptShown && titleShown) {
    return ''
  }
  if (promptShown) {
    return title
  }
  if (titleShown) {
    return prompt
  }
  return taskBody(title, prompt)
}

function note(id: string, role: 'user' | 'assistant', text: string): NativeChatMessage {
  return {
    id,
    role,
    blocks: [{ type: 'text', text }],
    timestamp: null,
    source: 'transcript'
  }
}

function lastAssistantText(messages: readonly NativeChatMessage[]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message?.role === 'assistant') {
      const text = textOf(message)
      if (text) {
        return text
      }
    }
  }
  return ''
}

/** Task at the top, child activity, then a parent result the child file does not already end with. */
export function frameNativeChatSubagentTranscript(
  agentId: string,
  page: readonly NativeChatMessage[],
  parents: readonly NativeChatMessage[],
  fallback?: NativeChatSubagentBriefFallback,
  includeResult = true
): NativeChatMessage[] {
  const activity = page.filter((message) => !echoedSpawn(message))
  const brief = nativeChatSubagentBriefs(parents).get(agentId)
  const title = brief?.title || fallback?.title || ''
  const prompt = brief?.prompt ?? ''
  const first = activity.find((message) => message.role === 'user')
  const lead = missingTask(first ? textOf(first) : '', title, prompt)
  const framed = lead ? [note(`${agentId}:task`, 'user', lead), ...activity] : activity.slice()
  const result = includeResult ? (brief?.result ?? null) : null
  if (result && !lastAssistantText(framed).includes(result.slice(0, Math.min(80, result.length)))) {
    framed.push(note(`${agentId}:result`, 'assistant', result))
  }
  return framed
}
