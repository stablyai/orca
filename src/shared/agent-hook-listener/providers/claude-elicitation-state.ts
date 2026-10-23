import type { HookListenerState } from '../listener-state'
import { readString } from '../tool-input-preview'

const MAX_ELICITATIONS = 64
const MAX_ACTIVE_TOOLS = 64

type ClaudeElicitationOwner = { sessionId: string; agentId?: string }
type ClaudeElicitation = ClaudeElicitationOwner & {
  serverName: string
  mode: 'form' | 'url'
  elicitationId?: string
  toolUseId?: string
  ambiguous?: true
}

export type ClaudeElicitationState = {
  pending: ClaudeElicitation[]
  activeTools: Map<string, ClaudeElicitationOwner & { serverName: string }>
  overflowOwners: Map<string, ClaudeElicitationOwner>
  unattributedOverflow?: true
  toolTrackingIncomplete?: true
}

function sameOwner(left: ClaudeElicitationOwner, right: ClaudeElicitationOwner): boolean {
  return left.sessionId === right.sessionId && left.agentId === right.agentId
}

function readOwner(payload: Record<string, unknown>): ClaudeElicitationOwner | undefined {
  const sessionId = readString(payload, 'session_id')
  return sessionId ? { sessionId, agentId: readString(payload, 'agent_id') } : undefined
}

function getRegistry(state: HookListenerState, paneKey: string): ClaudeElicitationState {
  let registry = state.claudeElicitationByPaneKey.get(paneKey)
  if (!registry) {
    registry = { pending: [], activeTools: new Map(), overflowOwners: new Map() }
    state.claudeElicitationByPaneKey.set(paneKey, registry)
  }
  return registry
}

export function claudePaneHasPendingElicitation(
  state: HookListenerState,
  paneKey: string
): boolean {
  const registry = state.claudeElicitationByPaneKey.get(paneKey)
  return (
    registry !== undefined &&
    (registry.unattributedOverflow === true ||
      registry.overflowOwners.size > 0 ||
      registry.pending.length > 0)
  )
}

export function clearClaudeElicitationsForOwner(
  state: HookListenerState,
  paneKey: string,
  ownsAgent: (agentId: string | undefined) => boolean,
  sessionId?: string
): void {
  const registry = state.claudeElicitationByPaneKey.get(paneKey)
  if (!registry) {
    return
  }
  const matches = (owner: ClaudeElicitationOwner): boolean =>
    ownsAgent(owner.agentId) && (sessionId === undefined || owner.sessionId === sessionId)
  registry.pending = registry.pending.filter((request) => !matches(request))
  for (const [id, owner] of registry.overflowOwners) {
    if (matches(owner)) {
      registry.overflowOwners.delete(id)
    }
  }
  for (const [id, tool] of registry.activeTools) {
    if (matches(tool)) {
      registry.activeTools.delete(id)
    }
  }
}

/** The provider omits tool ids on elicitation hooks; only a unique active MCP call can supply one. */
export function trackClaudeElicitationToolBoundary(
  state: HookListenerState,
  paneKey: string,
  eventName: unknown,
  payload: Record<string, unknown>
): void {
  const owner = readOwner(payload)
  const toolUseId = readString(payload, 'tool_use_id') ?? readString(payload, 'toolUseId')
  if (!owner || !toolUseId) {
    return
  }
  if (eventName === 'PreToolUse') {
    const toolName = readString(payload, 'tool_name')
    const serverName = toolName?.startsWith('mcp__') ? toolName.split('__')[1] : undefined
    if (!serverName) {
      return
    }
    const registry = getRegistry(state, paneKey)
    if (registry.activeTools.size < MAX_ACTIVE_TOOLS || registry.activeTools.has(toolUseId)) {
      registry.activeTools.set(toolUseId, { ...owner, serverName })
    } else {
      registry.toolTrackingIncomplete = true
      registry.pending = registry.pending.map(({ toolUseId: _untrusted, ...request }) => request)
    }
  } else if (eventName === 'PostToolUse' || eventName === 'PostToolUseFailure') {
    const registry = state.claudeElicitationByPaneKey.get(paneKey)
    const tool = registry?.activeTools.get(toolUseId)
    if (!registry || !tool || !sameOwner(tool, owner)) {
      return
    }
    const toolName = readString(payload, 'tool_name')
    if (toolName !== undefined && !toolName.startsWith(`mcp__${tool.serverName}__`)) {
      return
    }
    registry.activeTools.delete(toolUseId)
    registry.pending = registry.pending.filter(
      (request) => request.toolUseId !== toolUseId || !sameOwner(request, owner)
    )
  }
}

export function applyClaudeElicitationEvent(
  state: HookListenerState,
  paneKey: string,
  eventName: 'Elicitation' | 'ElicitationResult',
  payload: Record<string, unknown>
): boolean {
  const owner = readOwner(payload)
  const serverName = readString(payload, 'mcp_server_name')
  const mode = payload['mode']
  if (!owner || !serverName || (mode !== 'form' && mode !== 'url')) {
    return false
  }
  const sessionOwner = state.claudeSessionOwnerByPaneKey.get(paneKey)
  if (sessionOwner !== undefined && sessionOwner !== owner.sessionId) {
    return false
  }
  const elicitationId = readString(payload, 'elicitation_id')
  const registry = state.claudeElicitationByPaneKey.get(paneKey)
  const matches = (request: ClaudeElicitation): boolean =>
    sameOwner(request, owner) &&
    request.serverName === serverName &&
    request.mode === mode &&
    request.elicitationId === elicitationId
  if (eventName === 'ElicitationResult') {
    if (!registry || !['accept', 'decline', 'cancel'].includes(String(payload['action']))) {
      return false
    }
    const index = registry.pending.findIndex((request) => matches(request) && !request.ambiguous)
    if (index === -1) {
      return false
    }
    registry.pending.splice(index, 1)
    return true
  }
  if (sessionOwner === undefined && owner.agentId === undefined) {
    state.claudeSessionOwnerByPaneKey.set(paneKey, owner.sessionId)
  }
  const current = registry ?? getRegistry(state, paneKey)
  const activeTools = [...current.activeTools].filter(
    ([, tool]) => sameOwner(tool, owner) && tool.serverName === serverName
  )
  const existing = current.pending.find(matches)
  if (existing) {
    // Without an id, duplicates and concurrent forms are indistinguishable; await a scoped boundary.
    if (elicitationId === undefined) {
      existing.ambiguous = true
      if (activeTools.length !== 1 || activeTools[0][0] !== existing.toolUseId) {
        delete existing.toolUseId
      }
    }
    return true
  }
  if (current.pending.length >= MAX_ELICITATIONS) {
    const ownerKey = JSON.stringify([owner.sessionId, owner.agentId])
    if (current.overflowOwners.size < MAX_ELICITATIONS || current.overflowOwners.has(ownerKey)) {
      current.overflowOwners.set(ownerKey, owner)
    } else {
      // Beyond the owner bound, only a session reset can prove every outstanding request ended.
      current.unattributedOverflow = true
    }
    return true
  }
  current.pending.push({
    ...owner,
    serverName,
    mode,
    ...(elicitationId ? { elicitationId } : {}),
    ...(!current.toolTrackingIncomplete && activeTools.length === 1
      ? { toolUseId: activeTools[0][0] }
      : {})
  })
  return true
}
