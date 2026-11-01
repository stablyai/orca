import {
  openStructuredAgentSession,
  structuredSessionOpenFailure,
  type StructuredSessionOpenSource,
  type StructuredSessionOpenResult,
  type StructuredSessionOpenDeps,
  type StructuredSessionOpenTarget,
  type StructuredSessionOpenTab
} from '../../../shared/open-structured-agent-session'
import type { OrchestrationPartyLocationResult } from '../../../shared/orchestration-caller-status'
import {
  findStructuredAgentSessionTab,
  activateStructuredAgentSessionById
} from './agent-session/structured-agent-session-tab-activation'
import { useAppStore } from '@/store'
import { runtimeEnvironmentIdOrLocalUnlessTwin } from './worktree-runtime-owner'
import { callRuntimeRpc, runtimeEnvironmentSupportsCapability } from '@/runtime/runtime-rpc-client'
import type { RuntimeClientTarget } from '../../../shared/runtime-client-target'
import { runtimeTargetForOwnerEnvironment } from '@/runtime/runtime-client-target'
import { toRuntimeWorktreeSelector } from '@/runtime/runtime-worktree-selector'
import { refreshLocalStructuredSessionWorktreeTabs } from '@/runtime/local-structured-session-tabs-sync/inventory-refresh'
import { STRUCTURED_AGENT_SESSION_REVEAL_RUNTIME_CAPABILITY } from '../../../shared/agent-session/structured-agent-session-surface-capabilities'
import { isRuntimeCompatBlockError } from '@/runtime/runtime-protocol-compat'
import { executionHostIdForStructuredTarget } from '@/runtime/structured-agent-session-owner'

const STRUCTURED_SESSION_RESTORE_TIMEOUT_MS = 5_000

/** Keep distinct remedies: retry unreachable hosts, stop on a confirmed missing record, or update incompatible hosts/adapters. Failure to answer never proves a chat is gone. */
export type StructuredSessionRevealOutcome =
  | StructuredSessionOpenTarget
  | 'gone'
  | 'workspace-missing'
  | 'host-cannot-open'
  | 'unreachable'

export type StructuredSessionOpenAdapterDeps = {
  activate: typeof activateStructuredAgentSessionById
  tabs: (
    target: { sessionId: string; worktreeId: string },
    owner: RuntimeClientTarget
  ) => readonly StructuredSessionOpenTab[]
  refresh: (worktreeId: string, target?: RuntimeClientTarget) => Promise<void>
  reveal: (target: {
    worktreeId: string
    sessionId: string
    target?: RuntimeClientTarget
  }) => Promise<StructuredSessionRevealOutcome>
}

const defaultDeps: StructuredSessionOpenAdapterDeps = {
  activate: activateStructuredAgentSessionById,
  tabs: (target, owner) => {
    const tab = findStructuredAgentSessionTab(useAppStore.getState().unifiedTabsByWorktree, {
      workspaceId: target.worktreeId,
      sessionId: target.sessionId,
      target: owner
    })
    return tab ? [{ id: tab.id, sessionId: tab.entityId, agent: tab.agentSessionAgent }] : []
  },
  refresh: refreshStructuredSessionTabs,
  reveal: revealStructuredSession
}

export type StructuredSessionOpenOutcome = 'activated' | 'gone' | 'host-cannot-open' | 'unavailable'

export function structuredSessionOpenOutcome(
  result: StructuredSessionOpenResult
): StructuredSessionOpenOutcome {
  if (result.kind === 'opened') {
    return 'activated'
  }
  if (result.kind === 'failed' && result.failure.reason === 'gone') {
    return 'gone'
  }
  if (result.kind === 'failed' && result.failure.reason === 'unsupported') {
    return 'host-cannot-open'
  }
  return 'unavailable'
}

type DesktopInteractionOptions = {
  target?: RuntimeClientTarget
  deps?: StructuredSessionOpenAdapterDeps
  locate?: StructuredSessionOpenDeps['locate']
  initialize?: () => boolean
  present: (result: StructuredSessionOpenResult) => void
  onError?: () => void
}

const activationsInFlight = new Map<string, Promise<StructuredSessionOpenResult>>()

/** Admission precedes every owner effect; joiners only observe the rich settlement. */
export async function openDesktopStructuredSessionInteraction(
  source: StructuredSessionOpenSource,
  options: DesktopInteractionOptions
): Promise<StructuredSessionOpenResult> {
  const seedWorkspace =
    source.kind === 'history'
      ? source.structuredSession.workspaceId
      : source.kind === 'notification'
        ? source.worktreeId
        : source.fallback?.worktreeId
  let owner: RuntimeClientTarget
  try {
    owner =
      options.target ??
      runtimeTargetForOwnerEnvironment(
        runtimeEnvironmentIdOrLocalUnlessTwin(useAppStore.getState(), seedWorkspace ?? '')
      )
  } catch (error) {
    options.onError?.()
    throw error
  }
  const key =
    source.kind === 'history'
      ? `${executionHostIdForStructuredTarget(owner)}\0${source.structuredSession.workspaceId}\0${source.structuredSession.sessionId}`
      : undefined
  const pending = key === undefined ? undefined : activationsInFlight.get(key)
  if (pending) {
    return pending
  }
  let initialized = true
  const execute = async (): Promise<StructuredSessionOpenResult> => {
    initialized = options.initialize?.() !== false
    return initialized
      ? executeDesktopStructuredSession(source, owner, options.deps ?? defaultDeps, options.locate)
      : {
          kind: 'failed' as const,
          failure: { reason: 'unreachable' as const, beforeEffects: true }
        }
  }
  const activation = (key === undefined ? execute() : Promise.resolve().then(execute))
    .then(
      (result) => {
        if (initialized) {
          options.present(result)
        }
        return result
      },
      (error: unknown) => {
        options.onError?.()
        throw error
      }
    )
    .finally(() => {
      if (key !== undefined) {
        activationsInFlight.delete(key)
      }
    })
  if (key !== undefined) {
    activationsInFlight.set(key, activation)
  }
  return activation
}

export async function openExistingStructuredSession(
  structured: { workspaceId: string; sessionId: string },
  options: Omit<DesktopInteractionOptions, 'present'> & {
    present: (outcome: StructuredSessionOpenOutcome, result: StructuredSessionOpenResult) => void
  }
): Promise<StructuredSessionOpenOutcome> {
  const result = await openDesktopStructuredSessionInteraction(
    { kind: 'history', structuredSession: structured },
    { ...options, present: (value) => options.present(structuredSessionOpenOutcome(value), value) }
  )
  return structuredSessionOpenOutcome(result)
}

async function executeDesktopStructuredSession(
  source: StructuredSessionOpenSource,
  owner: RuntimeClientTarget,
  deps: StructuredSessionOpenAdapterDeps,
  locate?: StructuredSessionOpenDeps['locate']
): Promise<StructuredSessionOpenResult> {
  return openStructuredAgentSession(source, {
    locate:
      locate ??
      (async (address, messageIds) => {
        try {
          return await withStructuredSessionRestoreTimeout(
            callRuntimeRpc<OrchestrationPartyLocationResult>(
              owner,
              'orchestration.partyLocation',
              { address, ...(messageIds.length ? { messageIds } : {}) },
              { timeoutMs: STRUCTURED_SESSION_RESTORE_TIMEOUT_MS }
            )
          )
        } catch (error) {
          return structuredSessionOpenFailure(error)
        }
      }),
    tabs: (target) => deps.tabs(target, owner),
    activate: (tab, target) =>
      deps
        .tabs(target, owner)
        .some((row) => row.id === tab.id && row.sessionId === target.sessionId) &&
      deps.activate({ ...target, target: owner }),
    refresh: (target) => deps.refresh(target.worktreeId, owner),
    reveal: async (target) => {
      const outcome = await deps.reveal({ ...target, target: owner })
      return typeof outcome === 'object'
        ? outcome
        : {
            reason: outcome === 'host-cannot-open' ? 'unsupported' : outcome,
            beforeEffects: outcome !== 'unreachable'
          }
    }
  })
}

/** Only revealed promises a tab; preserve distinct retry/missing/update outcomes for the other replies. */
export async function revealStructuredSession(target: {
  worktreeId: string
  sessionId: string
  target?: RuntimeClientTarget
}): Promise<StructuredSessionRevealOutcome> {
  const host =
    target.target ??
    runtimeTargetForOwnerEnvironment(
      runtimeEnvironmentIdOrLocalUnlessTwin(useAppStore.getState(), target.worktreeId)
    )
  // Probe the answering paired host’s build; the local host shares this build and needs no probe.
  if (host.kind === 'environment') {
    let supported: boolean
    try {
      // Race even cached probe promises: an older unbounded probe must not hold the session’s in-flight guard forever.
      supported = await withStructuredSessionRestoreTimeout(
        runtimeEnvironmentSupportsCapability(
          host.environmentId,
          STRUCTURED_AGENT_SESSION_REVEAL_RUNTIME_CAPABILITY,
          STRUCTURED_SESSION_RESTORE_TIMEOUT_MS
        )
      )
    } catch (error) {
      // Only a version block proves age; other probe failures say nothing about the chat (as in remote-agent-session-launch).
      return isRuntimeCompatBlockError(error) ? 'host-cannot-open' : 'unreachable'
    }
    if (!supported) {
      return 'host-cannot-open'
    }
  }
  let result: AgentSessionRevealReply | undefined
  try {
    result = await withStructuredSessionRestoreTimeout(
      callRuntimeRpc<AgentSessionRevealReply>(
        host,
        'agentSession.reveal',
        { sessionId: target.sessionId },
        {
          timeoutMs: STRUCTURED_SESSION_RESTORE_TIMEOUT_MS
        }
      )
    )
  } catch {
    return 'unreachable'
  }
  if (result?.ok === true) {
    return { sessionId: result.sessionId, worktreeId: result.workspaceId, agent: result.agent }
  }
  // Distinguish a missing record from an existing record the host cannot open; only the first means gone.
  if (result?.refusal?.code === 'agent_session_workspace_removed') {
    return 'workspace-missing'
  }
  return result?.refusal?.code === 'agent_session_identity_required'
    ? 'gone'
    : result?.refusal?.code === 'agent_session_operation_unknown'
      ? 'unreachable'
      : 'host-cannot-open'
}

type AgentSessionRevealReply =
  | { ok: true; sessionId: string; workspaceId: string; agent: string }
  | { ok: false; refusal: { code?: string } }

async function refreshStructuredSessionTabs(
  worktreeId: string,
  target?: RuntimeClientTarget
): Promise<void> {
  const state = useAppStore.getState()
  const host =
    target ??
    runtimeTargetForOwnerEnvironment(runtimeEnvironmentIdOrLocalUnlessTwin(state, worktreeId))
  if (host.kind === 'local') {
    await withStructuredSessionRestoreTimeout(refreshLocalStructuredSessionWorktreeTabs(worktreeId))
    return
  }
  // Paired inventories arrive through their existing host-scoped subscription.
  await withStructuredSessionRestoreTimeout(
    callRuntimeRpc(
      host,
      'session.tabs.list',
      { worktree: toRuntimeWorktreeSelector(worktreeId) },
      { timeoutMs: STRUCTURED_SESSION_RESTORE_TIMEOUT_MS }
    )
  )
}

async function withStructuredSessionRestoreTimeout<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error('structured_session_restore_timeout')),
          STRUCTURED_SESSION_RESTORE_TIMEOUT_MS
        )
      })
    ])
  } finally {
    if (timer) {
      clearTimeout(timer)
    }
  }
}
