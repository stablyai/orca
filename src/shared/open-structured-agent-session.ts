import type { AgentMessageSender } from './agent-session/agent-session-message-source'
import type { OrchestrationPartyLocationResult } from './orchestration-caller-status'

export type StructuredSessionOpenTarget = { sessionId: string; worktreeId: string; agent?: string }
export type StructuredSessionOpenSource =
  | {
      kind: 'history'
      structuredSession: { sessionId: string; workspaceId: string }
      agent?: string
    }
  | ({ kind: 'notification' } & StructuredSessionOpenTarget)
  | {
      kind: 'sender'
      party: AgentMessageSender['party']
      messageIds: readonly string[]
      fallback?: StructuredSessionOpenTarget
      displayName?: string
    }
export type StructuredSessionOpenFailure = {
  reason: 'gone' | 'workspace-missing' | 'unknown' | 'unsupported' | 'unreachable'
  beforeEffects: boolean
  code?: string
  surface?: 'terminal'
}
export type StructuredSessionOpenTab = { id: string; sessionId: string; agent?: string }
export type StructuredSessionOpenResult =
  | { kind: 'opened'; target: StructuredSessionOpenTarget; tab: StructuredSessionOpenTab }
  | { kind: 'terminal'; handle: string }
  | { kind: 'failed'; failure: StructuredSessionOpenFailure }
  | { kind: 'superseded' }

type Located = OrchestrationPartyLocationResult | StructuredSessionOpenFailure
export type StructuredSessionOpenDeps = {
  locate: (address: string, messageIds: readonly string[]) => Promise<Located>
  tabs: (target: StructuredSessionOpenTarget) => readonly StructuredSessionOpenTab[]
  refresh: (target: StructuredSessionOpenTarget) => Promise<void>
  activate: (
    tab: StructuredSessionOpenTab,
    target: StructuredSessionOpenTarget
  ) => boolean | Promise<boolean>
  reveal: (
    target: StructuredSessionOpenTarget
  ) => Promise<StructuredSessionOpenTarget | StructuredSessionOpenFailure>
  current?: () => boolean
}

/** Only explicit unsupported responses prove that a fallback cannot duplicate an applied operation. */
export function structuredSessionOpenFailure(error: unknown): StructuredSessionOpenFailure {
  const code = error !== null && typeof error === 'object' && 'code' in error ? error.code : null
  if (
    code === 'invalid_argument' ||
    code === 'method_not_found' ||
    code === 'forbidden' ||
    code === 'structured_agent_session_unsupported' ||
    code === 'runtime_compat_block'
  ) {
    return { reason: 'unsupported', beforeEffects: true, code }
  }
  if (code === 'agent_session_workspace_removed') {
    return { reason: 'workspace-missing', beforeEffects: true }
  }
  if (code === 'agent_session_identity_required') {
    return { reason: 'gone', beforeEffects: true }
  }
  return { reason: 'unreachable', beforeEffects: false }
}

export async function resolveStructuredSessionOpenSource(
  source: StructuredSessionOpenSource,
  locate: StructuredSessionOpenDeps['locate']
): Promise<StructuredSessionOpenTarget | StructuredSessionOpenResult> {
  const seed =
    source.kind === 'history'
      ? {
          sessionId: source.structuredSession.sessionId,
          worktreeId: source.structuredSession.workspaceId,
          agent: source.agent
        }
      : source.kind === 'notification'
        ? source
        : source.fallback
  const address =
    source.kind === 'sender' ? source.party.address : `orca_session_id:${seed?.sessionId}`
  let found: Located
  try {
    found = await locate(address, source.kind === 'sender' ? source.messageIds : [])
  } catch (error) {
    found = structuredSessionOpenFailure(error)
  }
  if ('reason' in found) {
    if (source.kind !== 'sender' && found.reason === 'unsupported' && seed) {
      return seed
    }
    return { kind: 'failed', failure: found }
  }
  if (!found.location) {
    return {
      kind: 'failed',
      failure: {
        reason: found.lost ? 'gone' : 'unknown',
        beforeEffects: true,
        ...(found.lost === 'terminal' ? { surface: 'terminal' as const } : {})
      }
    }
  }
  if (found.location.kind === 'terminal') {
    return { kind: 'terminal', handle: found.location.handle }
  }
  if (found.location.kind !== 'chat') {
    return { kind: 'failed', failure: { reason: 'unsupported', beforeEffects: true } }
  }
  return {
    sessionId: found.location.sessionId,
    worktreeId: found.location.worktreeId,
    ...(source.kind !== 'sender' ? { agent: source.agent } : {})
  }
}

/** One policy for desktop and phone: refresh is advisory; reveal repairs missing publication. */
export async function openStructuredAgentSession(
  source: StructuredSessionOpenSource,
  deps: StructuredSessionOpenDeps
): Promise<StructuredSessionOpenResult> {
  const current = () => deps.current?.() !== false
  const seed =
    source.kind === 'history'
      ? {
          sessionId: source.structuredSession.sessionId,
          worktreeId: source.structuredSession.workspaceId,
          agent: source.agent
        }
      : null
  const known = async (target: StructuredSessionOpenTarget) => {
    if (!current()) {
      return null
    }
    const tab = deps.tabs(target).find((row) => row.sessionId === target.sessionId)
    if (!tab || !(await deps.activate(tab, target)) || !current()) {
      return null
    }
    return { kind: 'opened' as const, target: { ...target, agent: tab.agent ?? target.agent }, tab }
  }
  const refreshKnown = async (target: StructuredSessionOpenTarget) => {
    try {
      await deps.refresh(target)
    } catch {
      /* Inventory reads are advisory. */
    }
  }
  if (seed) {
    try {
      const direct = await known(seed)
      if (direct) {
        return direct
      }
      await refreshKnown(seed)
      const refreshed = await known(seed)
      if (refreshed) {
        return refreshed
      }
    } catch (error) {
      return { kind: 'failed', failure: structuredSessionOpenFailure(error) }
    }
  }
  const resolved = await resolveStructuredSessionOpenSource(source, deps.locate)
  if (!current()) {
    return { kind: 'superseded' }
  }
  if ('kind' in resolved) {
    if (
      source.kind === 'sender' &&
      resolved.kind === 'failed' &&
      (resolved.failure.code === 'method_not_found' || resolved.failure.code === 'forbidden')
    ) {
      const root = source.party.orcaSessionId
      if (root) {
        const fallback = source.fallback
        if (fallback?.sessionId === root) {
          try {
            if (!deps.tabs(fallback).some((row) => row.sessionId === root)) {
              await refreshKnown(fallback)
            }
            const opened = await known(fallback)
            if (!current()) {
              return { kind: 'superseded' }
            }
            if (opened) {
              return opened
            }
          } catch (error) {
            return { kind: 'failed', failure: structuredSessionOpenFailure(error) }
          }
        }
      } else {
        const handle = source.party.terminalHandle
        if (handle && !handle.startsWith('dispatch:') && !handle.startsWith('run:')) {
          return { kind: 'terminal', handle }
        }
      }
    }
    return resolved
  }
  let target: StructuredSessionOpenTarget = resolved
  const activate = async () => {
    if (!current()) {
      return null
    }
    const tab = deps.tabs(target).find((row) => row.sessionId === target.sessionId)
    return tab && (await deps.activate(tab, target)) ? tab : null
  }
  const refresh = async () => {
    try {
      await deps.refresh(target)
    } catch {
      /* Reveal can repair a failed inventory read. */
    }
  }
  let revealed = false
  const failure = (value: StructuredSessionOpenFailure): StructuredSessionOpenFailure => ({
    ...value,
    beforeEffects: value.beforeEffects && !revealed
  })
  try {
    let tab = await activate()
    if (!tab) {
      if (!seed || seed.sessionId !== target.sessionId || seed.worktreeId !== target.worktreeId) {
        await refresh()
      }
      tab = await activate()
      if (!tab && current()) {
        const reply = await deps.reveal(target)
        if (!current()) {
          return { kind: 'superseded' }
        }
        if ('reason' in reply) {
          return { kind: 'failed', failure: failure(reply) }
        }
        revealed = true
        target = reply
        await refresh()
        tab = await activate()
      }
    }
    if (!current()) {
      return { kind: 'superseded' }
    }
    return tab
      ? { kind: 'opened', target: { ...target, agent: tab.agent ?? target.agent }, tab }
      : { kind: 'failed', failure: { reason: 'unreachable', beforeEffects: false } }
  } catch (error) {
    return current()
      ? { kind: 'failed', failure: failure(structuredSessionOpenFailure(error)) }
      : { kind: 'superseded' }
  }
}
