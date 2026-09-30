// Which rows are part of delegating to subagents, rather than newer output that supersedes it.
//
// A roster row names the agents it announces, in the order they were added. A Codex collab
// call (spawn, wait, resume, message, close) names the agents it acts on by thread id, which
// is the agent id, and delegates to the first; one naming none (a spawn still starting, a
// wait on any agent) is ordinary output. A Claude spawn call names no agent — only its call id, which is re-minted on resume
// and never a join key — so it belongs to the roster that announces its agent. A drawn row is
// a spawn when its newest part is one.

import { isSubagentGroupBlock, type NativeChatMessage } from '../../../../shared/native-chat-types'

export type NativeChatSubagentDelegation =
  | { kind: 'roster'; agentIds: readonly string[] }
  | { kind: 'call'; agentId: string }
  | { kind: 'spawn' }

/** Claude's subagent spawn tool, under its current and its older name. */
const CLAUDE_SPAWN_TOOLS: ReadonlySet<string> = new Set(['Agent', 'Task'])

const CODEX_COLLAB_CALL_FRAME = 'item:collabAgentToolCall'

const delegations = new WeakMap<NativeChatMessage, NativeChatSubagentDelegation | null>()

export function nativeChatSubagentDelegation(
  message: NativeChatMessage
): NativeChatSubagentDelegation | null {
  const cached = delegations.get(message)
  if (cached !== undefined) {
    return cached
  }
  const delegation = derive(message)
  delegations.set(message, delegation)
  return delegation
}

function derive(message: NativeChatMessage): NativeChatSubagentDelegation | null {
  const rostered = message.blocks.flatMap((block) =>
    isSubagentGroupBlock(block) ? block.agents.map((agent) => agent.id) : []
  )
  if (rostered.length > 0) {
    return { kind: 'roster', agentIds: rostered }
  }
  const [only] = message.blocks
  const frame =
    message.blocks.length === 1 && only?.type === 'text' ? only.providerFrame : undefined
  if (frame?.provider === 'codex' && frame.kind === CODEX_COLLAB_CALL_FRAME) {
    const [agentId] = frame.payload.truncated ? [] : receiverThreadIds(frame.payload.head)
    return agentId === undefined ? null : { kind: 'call', agentId }
  }
  // A tool run folds into the message before it, so its last call is the newest thing in it.
  const newest = message.blocks.findLast((block) => block.type !== 'tool-result')
  return newest?.type === 'tool-call' && CLAUDE_SPAWN_TOOLS.has(newest.name)
    ? { kind: 'spawn' }
    : null
}

function receiverThreadIds(head: string): readonly string[] {
  let item: unknown
  try {
    item = JSON.parse(head)
  } catch {
    return []
  }
  if (typeof item !== 'object' || item === null || !('receiverThreadIds' in item)) {
    return []
  }
  const ids = item.receiverThreadIds
  return Array.isArray(ids)
    ? ids.filter((id): id is string => typeof id === 'string' && id.length > 0)
    : []
}
