import {
  openStructuredAgentSession,
  structuredSessionOpenFailure
} from '../../../../../shared/agent-session/view/open-structured-agent-session'
import { unreachableOpenFailure } from '../../../../../shared/agent-session/view/structured-session-open-failure-detail'
import type {
  StructuredSessionOpenSource,
  StructuredSessionOpenResult,
  StructuredSessionOpenDeps,
  StructuredSessionOpenTarget,
  StructuredSessionOpenTab,
  StructuredSessionOpenFailure
} from '../../../../../shared/agent-session/view/open-structured-agent-session'
import {
  findStructuredAgentSessionTab,
  activateStructuredAgentSessionById
} from '../structured-agent-session-tab-activation'
import { useAppStore } from '@/store/index'
import { runtimeEnvironmentIdOrLocalUnlessTwin } from '../../workspace/ownership/worktree-runtime-owner'
import { callRuntimeRpc } from '@/runtime/rpc/calls/runtime-rpc-call'
import { runtimeEnvironmentSupportsCapability } from '@/runtime/rpc/compatibility/runtime-capability-proof'
import { runtimeTargetForOwnerEnvironment } from '@/runtime/rpc/targets/runtime-client-target'
import { toRuntimeWorktreeSelector } from '@/runtime/rpc/targets/runtime-worktree-selector'
import { refreshLocalStructuredSessionWorktreeTabs } from '@/runtime/local-structured-session-tabs-sync/inventory-refresh'
import { STRUCTURED_AGENT_SESSION_REVEAL_RUNTIME_CAPABILITY } from '../../../../../shared/agent-session/capabilities/structured-agent-session-surface-capabilities'
import { isRuntimeCompatBlockError } from '@/runtime/rpc/compatibility/runtime-protocol-compat'
import { executionHostIdForStructuredTarget } from '@/runtime/native-chat/session-ownership/structured-agent-session-owner'
import type { OrchestrationPartyLocationResult } from '../../../../../shared/orchestration/orchestration-caller-status'
import type { RuntimeClientTarget } from '../../../../../shared/remote-runtime/host-catalog/runtime-client-target'
import type { RuntimeMobileSessionTabsResult } from '../../../../../shared/remote-runtime/session-graph/runtime-session-contracts'
import { worktreeIdsEqual } from '../../../../../shared/worktree/id'

const STRUCTURED_SESSION_RESTORE_TIMEOUT_MS = 5_000

/** Keep distinct remedies: retry unreachable hosts, stop on a confirmed missing record, or update incompatible hosts/adapters. Failure to answer never proves a chat is gone. */
export type StructuredSessionRevealOutcome =
  | StructuredSessionOpenTarget
  | StructuredSessionOpenFailure
  | 'gone'
  | 'host-cannot-open'
  | 'unreachable'

export type StructuredSessionOpenAdapterDeps = {
  activate: typeof activateStructuredAgentSessionById
  tabs: (
    target: { sessionId: string; worktreeId: string },
    owner: RuntimeClientTarget
  ) => readonly StructuredSessionOpenTab[]
  refresh: (target: StructuredSessionOpenTarget, owner: RuntimeClientTarget) => Promise<void>
  reveal: (target: {
    worktreeId: string
    sessionId: string
    target?: RuntimeClientTarget
  }) => Promise<StructuredSessionRevealOutcome>
  current?: () => boolean
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
  refresh: async (target, owner) => {
    await refreshStructuredSessionTabs(target.worktreeId, owner)
  },
  reveal: revealStructuredSession
}

export function structuredSessionOpenDepsWaitingForPairedTab(
  stillShowingWorkspace: () => boolean
): StructuredSessionOpenAdapterDeps {
  let superseded = false
  let mirrorDeadline: number | undefined
  const current = (): boolean => {
    superseded ||= !stillShowingWorkspace()
    return !superseded
  }
  return {
    ...defaultDeps,
    current,
    refresh: async ({ worktreeId, sessionId }, owner) => {
      if (!current()) {
        return
      }
      const deadline = performance.now() + STRUCTURED_SESSION_RESTORE_TIMEOUT_MS
      const snapshot = await refreshStructuredSessionTabs(worktreeId, owner)
      if (
        !snapshot ||
        typeof snapshot.worktree !== 'string' ||
        !worktreeIdsEqual(snapshot.worktree, worktreeId) ||
        !Array.isArray(snapshot.tabs) ||
        !snapshot.tabs.some((tab) => tab.type === 'agent-session' && tab.sessionId === sessionId)
      ) {
        return
      }
      // The reply can beat the mirror. A retry within this open shares the first wait's budget.
      mirrorDeadline ??= deadline
      await waitForPairedStructuredSessionTab(
        { workspaceId: worktreeId, sessionId, target: owner },
        mirrorDeadline - performance.now(),
        current
      )
    }
  }
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
  present: (result: StructuredSessionOpenResult, owner: RuntimeClientTarget) => void
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
          options.present(result, owner)
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
  const party =
    (method: 'orchestration.partyLocation' | 'orchestration.partyOpen') =>
    async (address: string, messageIds: readonly string[]) => {
      try {
        return await withStructuredSessionRestoreTimeout(
          callRuntimeRpc<OrchestrationPartyLocationResult>(
            owner,
            method,
            { address, ...(messageIds.length ? { messageIds } : {}) },
            { timeoutMs: STRUCTURED_SESSION_RESTORE_TIMEOUT_MS }
          )
        )
      } catch (error) {
        return structuredSessionOpenFailure(error)
      }
    }
  return openStructuredAgentSession(source, {
    current: deps.current,
    locate: locate ?? party('orchestration.partyLocation'),
    ...(locate ? {} : { open: party('orchestration.partyOpen') }),
    tabs: (target) => deps.tabs(target, owner),
    activate: (tab, target) =>
      deps
        .tabs(target, owner)
        .some((row) => row.id === tab.id && row.sessionId === target.sessionId) &&
      deps.activate({ ...target, target: owner }),
    refresh: (target) => deps.refresh(target, owner),
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
      return isRuntimeCompatBlockError(error) ? 'host-cannot-open' : unreachableOpenFailure(error)
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
  } catch (error) {
    return unreachableOpenFailure(error)
  }
  if (result?.ok === true) {
    return { sessionId: result.sessionId, worktreeId: result.workspaceId, agent: result.agent }
  }
  // Distinguish a missing record from an existing record the host cannot open; only the first means gone.
  if (result?.refusal?.code === 'agent_session_workspace_removed') {
    return structuredSessionOpenFailure(result.refusal)
  }
  return result?.refusal?.code === 'agent_session_identity_required'
    ? 'gone'
    : result?.refusal?.code === 'agent_session_operation_unknown'
      ? unreachableOpenFailure(result.refusal)
      : 'host-cannot-open'
}

type AgentSessionRevealReply =
  | { ok: true; sessionId: string; workspaceId: string; agent: string }
  | { ok: false; refusal: { code?: string; message?: string; details?: unknown } }

async function refreshStructuredSessionTabs(
  worktreeId: string,
  host: RuntimeClientTarget
): Promise<RuntimeMobileSessionTabsResult | undefined> {
  if (host.kind === 'local') {
    await withStructuredSessionRestoreTimeout(refreshLocalStructuredSessionWorktreeTabs(worktreeId))
    return undefined
  }
  return withStructuredSessionRestoreTimeout(
    callRuntimeRpc<RuntimeMobileSessionTabsResult>(
      host,
      'session.tabs.list',
      { worktree: toRuntimeWorktreeSelector(worktreeId) },
      { timeoutMs: STRUCTURED_SESSION_RESTORE_TIMEOUT_MS }
    )
  )
}

function waitForPairedStructuredSessionTab(
  tab: Parameters<typeof findStructuredAgentSessionTab>[1],
  timeoutMs: number,
  current: () => boolean
): Promise<void> {
  if (
    timeoutMs <= 0 ||
    !current() ||
    findStructuredAgentSessionTab(useAppStore.getState().unifiedTabsByWorktree, tab)
  ) {
    return Promise.resolve()
  }
  return new Promise((resolve) => {
    const finish = (): void => {
      clearTimeout(timer)
      unsubscribe()
      resolve()
    }
    const timer = setTimeout(finish, timeoutMs)
    const unsubscribe = useAppStore.subscribe((state, previous) => {
      if (
        !current() ||
        (state.unifiedTabsByWorktree[tab.workspaceId] !==
          previous.unifiedTabsByWorktree[tab.workspaceId] &&
          findStructuredAgentSessionTab(state.unifiedTabsByWorktree, tab))
      ) {
        finish()
      }
    })
  })
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
