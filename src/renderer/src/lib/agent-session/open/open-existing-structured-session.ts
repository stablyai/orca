import {
  openStructuredAgentSession,
  structuredSessionOpenFailure
} from '../../../../../shared/agent-session/view/open-structured-agent-session'
import type {
  StructuredSessionOpenSource,
  StructuredSessionOpenResult,
  StructuredSessionOpenDeps,
  StructuredSessionOpenTarget,
  StructuredSessionOpenTab
} from '../../../../../shared/agent-session/view/open-structured-agent-session'
import {
  findStructuredAgentSessionTab,
  activateStructuredAgentSessionById
} from '../structured-agent-session-tab-activation'
import { useAppStore } from '@/store/index'
import { runtimeEnvironmentIdOrLocalUnlessTwin } from '../../workspace/ownership/worktree-runtime-owner'
import { runtimeTargetForOwnerEnvironment } from '@/runtime/rpc/targets/runtime-client-target'
import { executionHostIdForStructuredTarget } from '@/runtime/native-chat/session-ownership/structured-agent-session-owner'
import type { RuntimeClientTarget } from '../../../../../shared/remote-runtime/host-catalog/runtime-client-target'
import { throwIfSignalAborted } from '../../../../../shared/concurrency/abort-signal-reason'
import {
  callStructuredSessionParty,
  refreshStructuredSessionTabs,
  revealStructuredSession,
  STRUCTURED_SESSION_RESTORE_TIMEOUT_MS,
  type StructuredSessionRevealOutcome,
  withStructuredSessionRestoreTimeout
} from './structured-session-restore'
import { pairedBotThreadRecovery } from './paired-bot-thread-recovery'

export type StructuredSessionOpenAdapterDeps = {
  activate: typeof activateStructuredAgentSessionById
  locate?: StructuredSessionOpenDeps['locate']
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
  signal?: AbortSignal
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

export function pairedBotThreadOpenDeps(
  linkedWorkspaceId: string,
  linkedSessionId: string,
  target: RuntimeClientTarget,
  signal: AbortSignal,
  current: () => boolean,
  activate: StructuredSessionOpenAdapterDeps['activate']
): StructuredSessionOpenAdapterDeps {
  const recovery =
    target.kind === 'environment'
      ? pairedBotThreadRecovery(target, linkedWorkspaceId, linkedSessionId, signal)
      : undefined
  return {
    ...defaultDeps,
    current,
    signal,
    activate,
    locate: recovery?.locate,
    reveal: recovery?.reveal ?? ((target) => revealStructuredSession({ ...target, signal })),
    refresh: async ({ worktreeId, sessionId }, owner) => {
      if (await recovery?.resumePending()) {
        return
      }
      if (!current()) {
        return
      }
      if (owner.kind === 'environment' && worktreeId === linkedWorkspaceId) {
        const timeout = new AbortController()
        const requestSignal = AbortSignal.any([signal, timeout.signal])
        await withStructuredSessionRestoreTimeout(
          import('@/runtime/web-session-tabs-sync/inventory/paired-chat-tab-reply').then(
            ({ readPairedChatTab }) =>
              readPairedChatTab({
                environmentId: owner.environmentId,
                worktreeId,
                sessionId,
                timeoutMs: STRUCTURED_SESSION_RESTORE_TIMEOUT_MS,
                minimumReceivedFrame: recovery?.minimumInventoryFrame(),
                signal: requestSignal,
                current
              })
          ),
          { onTimeout: () => timeout.abort() }
        )
      } else {
        await defaultDeps.refresh({ worktreeId, sessionId }, owner)
      }
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
    source.kind === 'history' && !options.deps?.signal
      ? `${executionHostIdForStructuredTarget(owner)}\0${source.structuredSession.workspaceId}\0${source.structuredSession.sessionId}`
      : undefined
  const pending = key === undefined ? undefined : activationsInFlight.get(key)
  if (pending) {
    return pending
  }
  const deps = options.deps ?? defaultDeps
  let initialized = true
  const execute = async (): Promise<StructuredSessionOpenResult> => {
    initialized = options.initialize?.() !== false
    return initialized
      ? executeDesktopStructuredSession(source, owner, deps, options.locate)
      : {
          kind: 'failed' as const,
          failure: { reason: 'unreachable' as const, beforeEffects: true }
        }
  }
  const activation = (key === undefined ? execute() : Promise.resolve().then(execute))
    .then(
      (result) => {
        if (initialized && (deps.current?.() ?? true)) {
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
          callStructuredSessionParty(
            owner,
            method,
            address,
            messageIds,
            deps.signal ? { beforeSend: () => throwIfSignalAborted(deps.signal) } : undefined
          ),
          { signal: deps.signal }
        )
      } catch (error) {
        return structuredSessionOpenFailure(error)
      }
    }
  return openStructuredAgentSession(source, {
    current: deps.current,
    locate: locate ?? deps.locate ?? party('orchestration.partyLocation'),
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
