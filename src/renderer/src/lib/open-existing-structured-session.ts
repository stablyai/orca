import {
  beginDesktopNavigation,
  canPresentDesktopNavigation,
  type DesktopNavigationRequest
} from './desktop-navigation'
import { activateStructuredAgentSessionById } from './agent-session/structured-agent-session-tab-activation'
import { useAppStore } from '@/store'
import { runtimeEnvironmentIdOrLocalUnlessTwin } from './worktree-runtime-owner'
import { callRuntimeRpc, runtimeEnvironmentSupportsCapability } from '@/runtime/runtime-rpc-client'
import type { RuntimeClientTarget } from '../../../shared/runtime-client-target'
import { runtimeTargetForOwnerEnvironment } from '@/runtime/runtime-client-target'
import { toRuntimeWorktreeSelector } from '@/runtime/runtime-worktree-selector'
import { refreshLocalStructuredSessionWorktreeTabs } from '@/runtime/local-structured-session-tabs-sync/inventory-refresh'
import { STRUCTURED_AGENT_SESSION_REVEAL_RUNTIME_CAPABILITY } from '../../../shared/protocol-version'
import { isRuntimeCompatBlockError } from '@/runtime/runtime-protocol-compat'
import { executionHostIdForStructuredTarget } from '@/runtime/structured-agent-session-owner'

type StructuredSessionIdentity = { workspaceId: string; sessionId: string }

const STRUCTURED_SESSION_RESTORE_TIMEOUT_MS = 5_000

/** Keep distinct remedies: retry unreachable hosts, stop on a confirmed missing record, or update incompatible hosts/adapters. Failure to answer never proves a chat is gone. */
export type StructuredSessionRevealOutcome =
  | 'revealed'
  | 'gone'
  | 'host-cannot-open'
  | 'unreachable'

export type StructuredSessionOpenDeps = {
  activate: typeof activateStructuredAgentSessionById
  refresh: (worktreeId: string, target?: RuntimeClientTarget) => Promise<void>
  reveal: (target: {
    worktreeId: string
    sessionId: string
    target?: RuntimeClientTarget
  }) => Promise<StructuredSessionRevealOutcome>
}

export type StructuredSessionOpenOutcome = 'activated' | 'gone' | 'host-cannot-open' | 'unavailable'

const defaultDeps: StructuredSessionOpenDeps = {
  activate: activateStructuredAgentSessionById,
  refresh: refreshStructuredSessionTabs,
  reveal: revealStructuredSession
}

const activationsInFlight = new Map<
  string,
  { work: Promise<StructuredSessionOpenOutcome>; latestClaim: number }
>()

/** Share bounded restoration work; each caller retains its own foreground claim. */
export async function openExistingStructuredSession(
  structured: StructuredSessionIdentity,
  options: {
    target?: RuntimeClientTarget
    navigation?: DesktopNavigationRequest
    deps?: StructuredSessionOpenDeps
    present: (outcome: StructuredSessionOpenOutcome) => void
    onError?: () => void
  }
): Promise<StructuredSessionOpenOutcome> {
  const { target, deps = defaultDeps, present } = options
  const hostKey = executionHostIdForStructuredTarget(
    target ??
      runtimeTargetForOwnerEnvironment(
        runtimeEnvironmentIdOrLocalUnlessTwin(useAppStore.getState(), structured.workspaceId)
      )
  )
  const key = `${hostKey}\0${structured.workspaceId}\0${structured.sessionId}`
  const navigation = options.navigation ?? beginDesktopNavigation()
  let activation = activationsInFlight.get(key)
  if (!activation) {
    activation = {
      work: activateStructuredSession(structured, deps, target),
      latestClaim: navigation.id
    }
    activationsInFlight.set(key, activation)
    void activation.work
      .finally(() => {
        if (activationsInFlight.get(key) === activation) {
          activationsInFlight.delete(key)
        }
      })
      .catch(() => {})
  }
  activation.latestClaim = navigation.id
  try {
    let outcome = await activation.work
    if (activation.latestClaim === navigation.id && canPresentDesktopNavigation(navigation)) {
      if (
        outcome === 'activated' &&
        !deps.activate({
          worktreeId: structured.workspaceId,
          sessionId: structured.sessionId,
          ...(target ? { target } : {}),
          navigation
        })
      ) {
        outcome = 'unavailable'
      }
      present(outcome)
    }
    return outcome
  } catch (error) {
    options.onError?.()
    throw error
  }
}

async function activateStructuredSession(
  structured: StructuredSessionIdentity,
  deps: StructuredSessionOpenDeps,
  host?: RuntimeClientTarget
): Promise<StructuredSessionOpenOutcome> {
  const target = {
    worktreeId: structured.workspaceId,
    sessionId: structured.sessionId,
    ...(host ? { target: host } : {})
  }
  if (!deps.activate({ ...target, navigation: null })) {
    // Refresh can avoid reveal, but failure must fall through: host republication is the actual repair.
    const refreshed = await refreshedWithoutThrowing(deps, structured.workspaceId, host)
    if (!refreshed || !deps.activate({ ...target, navigation: null })) {
      // Ask the host to republish a closed or unpublished tab from its persisted record.
      const revealed = await deps.reveal(target)
      if (revealed !== 'revealed') {
        return revealed === 'unreachable' ? 'unavailable' : revealed
      }
      await refreshedWithoutThrowing(deps, structured.workspaceId, host)
      if (!deps.activate({ ...target, navigation: null })) {
        return 'unavailable'
      }
    }
  }
  return 'activated'
}

/** Refresh is advisory; failures return false so reveal can still proceed. */
async function refreshedWithoutThrowing(
  deps: StructuredSessionOpenDeps,
  worktreeId: string,
  target?: RuntimeClientTarget
): Promise<boolean> {
  try {
    await (target ? deps.refresh(worktreeId, target) : deps.refresh(worktreeId))
    return true
  } catch {
    return false
  }
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
    return 'revealed'
  }
  // Distinguish a missing record from an existing record the host cannot open; only the first means gone.
  return result?.refusal?.code === 'agent_session_identity_required' ? 'gone' : 'host-cannot-open'
}

type AgentSessionRevealReply = { ok?: boolean; refusal?: { code?: string } }

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
