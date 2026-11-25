import { workspaceKindForWorktreeId } from '../../agent-launch/contracts/workspace-launch-kind'
import * as openFailure from './structured-session-open-failure-detail'
import type {
  StructuredSessionOpenDeps,
  StructuredSessionOpenFailure,
  StructuredSessionOpenInventoryRecheck,
  StructuredSessionOpenResult,
  StructuredSessionOpenSource,
  StructuredSessionOpenTarget
} from './structured-session-open-types'

export {
  readStructuredSessionWorkspaceRemovedDetails,
  type StructuredSessionWorkspaceRemovedDetails
} from './structured-session-open-failure-detail'

export type {
  StructuredSessionOpenDeps,
  StructuredSessionOpenFailure,
  StructuredSessionOpenInventoryRecheck,
  StructuredSessionOpenResult,
  StructuredSessionOpenSource,
  StructuredSessionOpenTab,
  StructuredSessionOpenTarget,
  StructuredSessionRemovedWorkspaceKind
} from './structured-session-open-types'

type Located = Awaited<ReturnType<StructuredSessionOpenDeps['locate']>>

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
    const details = openFailure.readStructuredSessionWorkspaceRemovedDetails(
      error !== null && typeof error === 'object' && 'details' in error ? error.details : undefined
    )
    return { reason: 'workspace-missing', beforeEffects: true, ...details }
  }
  if (code === 'agent_session_identity_required') {
    return { reason: 'gone', beforeEffects: true }
  }
  return openFailure.unreachableOpenFailure(error)
}

export async function resolveStructuredSessionOpenSource(
  source: StructuredSessionOpenSource,
  locate: StructuredSessionOpenDeps['locate']
): Promise<
  StructuredSessionOpenTarget | StructuredSessionOpenResult | StructuredSessionOpenInventoryRecheck
> {
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
  if ('recheck' in found) {
    return found
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
    const { handle, environmentId } = found.location
    return { kind: 'terminal', handle, ...(environmentId ? { environmentId } : {}) }
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
  const recheckInventory = async (
    reply: StructuredSessionOpenInventoryRecheck
  ): Promise<StructuredSessionOpenResult> => {
    await refreshKnown(reply.recheck)
    try {
      const opened = await known(reply.recheck)
      return !current()
        ? { kind: 'superseded' }
        : (opened ?? { kind: 'failed', failure: reply.failure })
    } catch (error) {
      return current()
        ? { kind: 'failed', failure: structuredSessionOpenFailure(error) }
        : { kind: 'superseded' }
    }
  }
  if (!current()) {
    return { kind: 'superseded' }
  }
  if (seed) {
    try {
      const direct = await known(seed)
      if (direct) {
        return direct
      }
      if (!current()) {
        return { kind: 'superseded' }
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
  if (!current()) {
    return { kind: 'superseded' }
  }
  const resolved = await resolveStructuredSessionOpenSource(
    source,
    source.kind === 'sender' && deps.open ? openingOrLocating(deps.open, deps.locate) : deps.locate
  )
  if (!current()) {
    return { kind: 'superseded' }
  }
  if ('recheck' in resolved) {
    return recheckInventory(resolved)
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
    ...(value.reason === 'workspace-missing'
      ? {
          workspaceKind:
            value.workspaceKind ??
            (workspaceKindForWorktreeId(target.worktreeId) === 'folder' ? 'folder' : 'git-worktree')
        }
      : {}),
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
        if ('recheck' in reply) {
          return recheckInventory(reply)
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
      : { kind: 'failed', failure: openFailure.TAB_NEVER_APPEARED }
  } catch (error) {
    return current()
      ? { kind: 'failed', failure: failure(structuredSessionOpenFailure(error)) }
      : { kind: 'superseded' }
  }
}

/** Older hosts refuse the opening call, so they keep answering the plain lookup. */
function openingOrLocating(
  open: NonNullable<StructuredSessionOpenDeps['open']>,
  locate: StructuredSessionOpenDeps['locate']
): StructuredSessionOpenDeps['locate'] {
  return async (address, messageIds) => {
    let opened: Located
    try {
      opened = await open(address, messageIds)
    } catch (error) {
      opened = structuredSessionOpenFailure(error)
    }
    return 'reason' in opened && (opened.code === 'method_not_found' || opened.code === 'forbidden')
      ? locate(address, messageIds)
      : opened
  }
}
