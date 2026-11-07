import {
  useAppViewExternalStore,
  useAppStateViewActive,
  useAppStateValue
} from '@/store/app-state-view'
import { useEffect, useMemo } from 'react'
import { useAppStore } from '@/store'
import type { ProspectiveWorkspace } from './agent-session/launch/routing/agent-launch-route-input'
import {
  agentsOfferedForLaunch,
  resolveChatProgramContext,
  subscribeChatProgramFacts,
  readChatProgramFactsVersion
} from './host-chat-program'
import { ensureLocalRuntimeCapabilities } from '@/runtime/hosts/capabilities/local-runtime-capabilities'
import { loadHostStructuredAgents } from '@/runtime/host-structured-agents'
import {
  acquireHostStructuredAgentAvailability,
  firstHostStructuredAgentAvailability
} from '@/runtime/host-structured-agent-availability'
import { onRuntimeEnvironmentsRetired } from '@/runtime/rpc/environment-revisions/runtime-environment-revision'
import { STRUCTURED_AGENT_SESSION_AVAILABILITY_RUNTIME_CAPABILITY as AVAILABILITY } from '../../../shared/agent-session/structured-agent-session-surface-capabilities'
import type { TuiAgent } from '../../../shared/agent-launch/catalog/tui-agent'
import type { AppState } from '@/store/types'
import { isTuiAgent } from '../../../shared/agent-launch/catalog/tui-agent-config'
import {
  getDetectionTargetIdentityForWorktree,
  readAgentInventoryForWorktree
} from './agent-detection-target-inventory'

export const useChatProgramFactsVersion = (): number =>
  useAppViewExternalStore(
    subscribeChatProgramFacts,
    readChatProgramFactsVersion,
    readChatProgramFactsVersion
  )

/** A hold owns one resolved resource; its consumer owns reconciliation. */
export function holdChatProgramFacts(context: ReturnType<typeof resolveChatProgramContext>) {
  if (!context.target || context.runtimeId === undefined || !context.hostCapabilities) {
    const catalog =
      !context.target && context.executionHostId
        ? Promise.resolve()
        : context.runtimeId === null
          ? ensureLocalRuntimeCapabilities()
          : new Promise<void>(() => {})
    return { catalog, first: () => catalog, release: (): void => {} }
  }
  const owner = {
    ...context,
    target: context.target,
    runtimeId: context.runtimeId
  }
  const catalog = loadHostStructuredAgents(
    context.executionHostId,
    context.hostCapabilities,
    context.runtimeId
  )
  const health = context.hostCapabilities.includes(AVAILABILITY)
  const release = health ? acquireHostStructuredAgentAvailability(owner) : (): void => {}
  const first = () => (health ? firstHostStructuredAgentAvailability(owner) : catalog)
  return { catalog, first, release }
}

export function useChatProgramFacts(workspace: ProspectiveWorkspace, active = true): void {
  const viewActive = useAppStateViewActive()
  useChatProgramFactsVersion()
  // Hidden worktrees' tab bars stay mounted; resolving per store write there is wasted work.
  const key = useAppStateValue((state) =>
    active ? resolveChatProgramContext(state, workspace).revision : null
  )
  useEffect(() => {
    return active && viewActive
      ? holdChatProgramFacts(resolveChatProgramContext(useAppStore.getState(), workspace)).release
      : undefined
    // The descriptor covers all owner inputs; resource notifications do not reopen a live lease.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, active, viewActive])
}

/** Listing and selected-entry readiness are separate; null preserves pending-inventory fallback. */
export function useAgentsOfferedForLaunch(
  workspace: ProspectiveWorkspace,
  detected: ReadonlySet<TuiAgent> | null
): ReadonlySet<TuiAgent> | null {
  useChatProgramFacts(workspace)
  const key = useAppStateValue((state) =>
    detected === null ? null : agentsOfferedForLaunch(state, workspace, [...detected]).join(',')
  )
  return useMemo(() => (key === null ? null : new Set(key.split(',').filter(isTuiAgent))), [key])
}

export class AgentLaunchChoiceCancelled extends Error {}
/** Chat discovery is bounded; ordinary CLI discovery keeps its existing wait. */
export async function acquireAgentLaunchChoices(
  workspace: ProspectiveWorkspace,
  detect: () => Promise<readonly TuiAgent[] | null>,
  signal?: AbortSignal,
  totalDeadline = false,
  getState: () => AppState = useAppStore.getState
) {
  let bound = resolveChatProgramContext(getState(), workspace)
  let target = workspace.worktreeId
    ? getDetectionTargetIdentityForWorktree(getState(), workspace.worktreeId)
    : null
  let ended = false
  let lease = holdChatProgramFacts(bound)
  let changed = Promise.withResolvers<void>()
  let failure: AgentLaunchChoiceCancelled | undefined
  const { promise: cancelled, reject: rejectCancelled } = Promise.withResolvers<never>()
  const cancel = (): void => {
    failure = new AgentLaunchChoiceCancelled('Agent launch owner changed or action cancelled')
    rejectCancelled(failure)
  }
  const check = (): void => {
    const next = resolveChatProgramContext(getState(), workspace)
    const nextTarget = workspace.worktreeId
      ? getDetectionTargetIdentityForWorktree(getState(), workspace.worktreeId)
      : null
    if (
      (bound.executionHostId && next.executionHostId !== bound.executionHostId) ||
      (bound.runtimeId !== undefined && next.runtimeId !== bound.runtimeId) ||
      (bound.pairingRevision !== undefined && next.pairingRevision !== bound.pairingRevision) ||
      (target && nextTarget !== target)
    ) {
      cancel()
    } else {
      const replace = bound.revision !== next.revision && !ended
      bound = next
      target = nextTarget
      if (replace) {
        const retired = lease
        lease = holdChatProgramFacts(bound)
        retired.release()
        changed.resolve()
        changed = Promise.withResolvers<void>()
      }
    }
  }
  const stopStore = useAppStore.subscribe(check)
  const stopFacts = subscribeChatProgramFacts(check)
  const stopRetirement = onRuntimeEnvironmentsRetired(
    (ids) => bound.environmentId && ids.includes(bound.environmentId) && cancel()
  )
  const { promise: expired, resolve: resolveExpired } = Promise.withResolvers<null>()
  const expire = (): void => {
    ended = true
    lease.release()
    changed.resolve()
    resolveExpired(null)
  }
  const timer = setTimeout(expire, 5_000)
  signal?.addEventListener('abort', cancel, { once: true })
  try {
    if (signal?.aborted) {
      cancel()
    }
    const detection = detect()
    const detected = await Promise.race([
      totalDeadline ? Promise.race([detection, expired]) : detection,
      cancelled
    ])
    do {
      check()
      const observed = lease
      const first = observed.first()
      await Promise.race([Promise.all([observed.catalog, first]), changed.promise, cancelled])
      check()
      if (failure) {
        throw failure
      }
      if (ended || (observed === lease && first === lease.first())) {
        break
      }
    } while (!ended)
    const inventory = workspace.worktreeId
      ? readAgentInventoryForWorktree(getState(), workspace.worktreeId)
      : null
    const trustworthy = inventory
      ? inventory.state === 'successful' || inventory.ids?.length
        ? inventory.ids
        : null
      : detected
    return {
      detected: trustworthy,
      offered: agentsOfferedForLaunch(getState(), workspace, trustworthy)
    }
  } finally {
    ended = true
    clearTimeout(timer)
    signal?.removeEventListener('abort', cancel)
    stopStore()
    stopFacts()
    stopRetirement()
    lease.release()
  }
}
