import type { AgentJournalToolCallItem } from './agent-session-journal-types'
import { isRecord } from './agent-status-child-work-value-guards'
import { AGENT_STATUS_MAX_SUBAGENTS, type AgentSubagentSnapshot } from './agent-status-types'
import type { NativeChatMessage } from './native-chat-types'
import { isRootAgentJournalItem } from './agent-session-journal-producer'

const TOOLS: Readonly<Record<string, string>> = {
  spawnAgent: 'spawn_agent',
  sendInput: 'send_message',
  resumeAgent: 'resume_agent',
  wait: 'wait_agent',
  closeAgent: 'close_agent',
  sendMessage: 'send_message',
  followupTask: 'followup_task',
  interruptAgent: 'interrupt_agent',
  listAgents: 'list_agents'
}
const KINDS = new Set(['started', 'interacted', 'interrupted', 'completed'])
const STATES = new Set(['inProgress', 'completed', 'failed', 'interrupted'])
const THREAD_ID = /^[A-Za-z0-9_-]{1,64}$/

export function codexSubagentItem(value: unknown): AgentJournalToolCallItem | null {
  if (!isRecord(value)) {
    return null
  }
  const item = value
  if (item.type === 'subAgentActivity') {
    if (
      typeof item.kind !== 'string' ||
      !KINDS.has(item.kind) ||
      typeof item.agentThreadId !== 'string' ||
      !THREAD_ID.test(item.agentThreadId) ||
      typeof item.agentPath !== 'string' ||
      item.agentPath.length > 4096
    ) {
      return null
    }
    return {
      kind: 'tool-call',
      name: 'subagent_activity',
      state: 'completed',
      input: {
        type: item.type,
        kind: item.kind,
        agentThreadId: item.agentThreadId,
        agentPath: item.agentPath,
        description: `${item.kind}: ${item.agentPath}`
      }
    }
  }
  if (
    item.type !== 'collabAgentToolCall' ||
    typeof item.tool !== 'string' ||
    !Object.hasOwn(TOOLS, item.tool) ||
    typeof item.status !== 'string' ||
    !STATES.has(item.status)
  ) {
    return null
  }
  return {
    kind: 'tool-call',
    name: TOOLS[item.tool]!,
    input: item,
    state:
      item.status === 'inProgress'
        ? 'running'
        : item.status === 'completed'
          ? 'completed'
          : 'failed'
  }
}

/** Recover known events from older journals without rewriting their durable rows. */
export function codexSubagentProviderFrame(frame: {
  provider: string
  kind: string
  payload: { head: string; truncated: boolean }
}): AgentJournalToolCallItem | null {
  if (
    frame.provider !== 'codex' ||
    frame.payload.truncated ||
    (frame.kind !== 'item:subAgentActivity' && frame.kind !== 'item:collabAgentToolCall')
  ) {
    return null
  }
  try {
    return codexSubagentItem(JSON.parse(frame.payload.head))
  } catch {
    return null
  }
}

export function codexLiveSubagents(
  messages: readonly NativeChatMessage[]
): AgentSubagentSnapshot[] {
  const children = new Map<string, AgentSubagentSnapshot>()
  for (const message of messages) {
    if (!isRootAgentJournalItem(message)) {
      continue
    }
    for (const block of message.blocks) {
      if (block.type === 'subagent-group') {
        for (const child of block.agents) {
          if (!THREAD_ID.test(child.id)) {
            continue
          }
          if (child.state !== 'working') {
            children.delete(child.id)
          } else if (children.has(child.id) || children.size < AGENT_STATUS_MAX_SUBAGENTS) {
            children.set(child.id, {
              id: child.id,
              description: child.label,
              state: 'working',
              startedAt: child.startedAt ?? message.timestamp ?? 0
            })
          }
        }
        continue
      }
      const call =
        block.type === 'tool-call'
          ? block
          : block.type === 'text' && block.providerFrame
            ? codexSubagentProviderFrame(block.providerFrame)
            : null
      if (!call || !isRecord(call.input)) {
        continue
      }
      const item = call.input
      if (!codexSubagentItem(item)) {
        continue
      }
      if (item.type === 'collabAgentToolCall') {
        if (!isRecord(item.agentsStates)) {
          continue
        }
        for (const [id, value] of Object.entries(item.agentsStates)) {
          if (!THREAD_ID.test(id) || !isRecord(value)) {
            continue
          }
          const status = value.status
          if (
            ['completed', 'interrupted', 'errored', 'shutdown', 'notFound'].includes(String(status))
          ) {
            children.delete(id)
          } else if (
            (status === 'running' || status === 'pendingInit') &&
            children.size < AGENT_STATUS_MAX_SUBAGENTS
          ) {
            children.set(
              id,
              children.get(id) ?? {
                id,
                state: 'working',
                startedAt: message.timestamp ?? 0,
                ...(typeof item.model === 'string' ? { model: item.model } : {})
              }
            )
          }
        }
        continue
      }
      if (typeof item.agentThreadId !== 'string' || typeof item.agentPath !== 'string') {
        continue
      }
      const id = item.agentThreadId
      if (item.kind === 'completed' || item.kind === 'interrupted') {
        children.delete(id)
        continue
      }
      const existing = children.get(id)
      if (!existing && children.size >= AGENT_STATUS_MAX_SUBAGENTS) {
        continue
      }
      children.set(id, {
        id,
        description: item.agentPath,
        agentType: item.agentPath.split('/').at(-1),
        state: 'working',
        startedAt: existing?.startedAt ?? message.timestamp ?? 0
      })
    }
  }
  return [...children.values()]
}
