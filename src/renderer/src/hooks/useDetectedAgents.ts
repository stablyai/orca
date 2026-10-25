import { useCallback, useEffect, useRef } from 'react'
import { useAppStore } from '@/store'
import type { TuiAgent } from '../../../shared/tui-agent'
import { getRuntimeAgentInventoryKey } from '@/store/slices/runtime-agent-inventory-key'

export type UseDetectedAgentsResult = {
  /** Null while detection is in flight on first load. */
  detectedIds: TuiAgent[] | null
  isLoading: boolean
  /** True when the first probe for this mounted remote target finished without a result. */
  detectionFailed: boolean
  isRefreshing: boolean
  /** True when the runtime host is too old to list this workspace's agents. */
  needsServerUpdate: boolean
  /** Refresh the list’s owner host and publish to all surfaces; concurrent refreshes share the pending promise. */
  refresh: () => Promise<TuiAgent[]>
}

export type AgentDetectionTarget =
  | { kind: 'local'; worktreeId?: string | null; contextKey?: string }
  | { kind: 'ssh'; connectionId: string }
  // worktreeId: the host resolves that workspace's runtime; absent means the host default.
  | { kind: 'runtime'; environmentId: string; worktreeId?: string | null }

function normalizeAgentDetectionTarget(
  target: AgentDetectionTarget | string | null | undefined
): AgentDetectionTarget | undefined {
  if (target === undefined) {
    return undefined
  }
  if (target === null) {
    return { kind: 'local' }
  }
  if (typeof target === 'string') {
    return { kind: 'ssh', connectionId: target }
  }
  return target
}

/** One detected-agent inventory keeps launch surfaces synchronized. Accept legacy SSH IDs or host targets; null means local, undefined means unresolved/loading. */
export function useDetectedAgents(
  connectionId: AgentDetectionTarget | string | null | undefined
): UseDetectedAgentsResult {
  const target = normalizeAgentDetectionTarget(connectionId)
  const observedRemoteTargetKeysRef = useRef<Set<string>>(new Set())
  // Undefined ownership stays loading so remote hydration cannot flash local agents.
  const isUnknown = target === undefined
  const targetKind = target?.kind
  const targetId =
    target?.kind === 'ssh'
      ? target.connectionId
      : target?.kind === 'runtime'
        ? target.environmentId
        : null
  const localWorktreeId = target?.kind === 'local' ? target.worktreeId : undefined
  const runtimeWorktreeId = target?.kind === 'runtime' ? target.worktreeId : undefined
  // Records for a runtime host are per workspace; ssh/local records keep their own keys.
  const recordKey =
    targetKind === 'runtime' && targetId
      ? getRuntimeAgentInventoryKey(targetId, runtimeWorktreeId)
      : targetId
  const localContextKey = target?.kind === 'local' ? target.contextKey : undefined
  const remoteTargetKey =
    targetKind === 'ssh' && targetId
      ? `ssh:${targetId}`
      : targetKind === 'runtime' && recordKey
        ? `runtime:${recordKey}`
        : null
  // Why: a re-pair clears the record; re-running the effect re-probes for a surface still waiting.
  const pairingRevision = useAppStore((s) => {
    if (targetKind !== 'runtime' || !targetId) {
      return undefined
    }
    const environment = s.runtimeEnvironments.find((entry) => entry.id === targetId)
    return environment ? (environment.pairingRevision ?? environment.createdAt) : undefined
  })

  const detectedIds = useAppStore((s) => {
    if (isUnknown) {
      return null
    }
    if (targetKind === 'ssh' && targetId) {
      return s.remoteDetectedAgentIds[targetId] ?? null
    }
    if (targetKind === 'runtime' && recordKey) {
      return s.runtimeDetectedAgentIds[recordKey] ?? null
    }
    return localContextKey
      ? (s.localDetectedAgentIdsByContext[localContextKey] ?? null)
      : s.detectedAgentIds
  })
  const isLoading = useAppStore((s) => {
    if (isUnknown) {
      return true
    }
    if (targetKind === 'ssh' && targetId) {
      return s.isDetectingRemoteAgents[targetId] ?? false
    }
    if (targetKind === 'runtime' && recordKey) {
      return s.isDetectingRuntimeAgents[recordKey] ?? false
    }
    return localContextKey
      ? (s.isDetectingLocalAgentsByContext[localContextKey] ?? false)
      : s.isDetectingAgents
  })
  const isRefreshing = useAppStore((s) => {
    if (targetKind === 'runtime' && recordKey) {
      return s.isRefreshingRuntimeAgents[recordKey] ?? false
    }
    if (targetKind === 'ssh' && targetId) {
      return s.isDetectingRemoteAgents[targetId] ?? false
    }
    if (targetKind !== 'local') {
      return false
    }
    return localContextKey
      ? (s.isRefreshingLocalAgentsByContext[localContextKey] ?? false)
      : s.isRefreshingAgents
  })
  const needsServerUpdate = useAppStore((s) =>
    targetKind === 'runtime' && recordKey
      ? s.runtimeAgentDetectionNeedsServerUpdate[recordKey] === true
      : false
  )
  const detectionFailed =
    detectedIds === null &&
    !isLoading &&
    !isRefreshing &&
    remoteTargetKey !== null &&
    observedRemoteTargetKeysRef.current.has(remoteTargetKey)
  const localProbePending = targetKind === 'local' && (isLoading || isRefreshing)
  // Refresh the inventory’s host; refreshing local PATH while showing remote agents would silently do nothing.
  const refresh = useCallback((): Promise<TuiAgent[]> => {
    if (isUnknown) {
      return Promise.resolve([])
    }
    // Imperative action reads avoid six inert subscriptions per retained tab bar.
    const state = useAppStore.getState()
    if (targetKind === 'runtime' && targetId) {
      return state.refreshRuntimeDetectedAgents(targetId, runtimeWorktreeId)
    }
    if (targetKind === 'ssh' && targetId) {
      return state.refreshRemoteDetectedAgents(targetId)
    }
    return state.refreshDetectedAgents(localWorktreeId)
  }, [isUnknown, localWorktreeId, runtimeWorktreeId, targetKind, targetId])

  useEffect(() => {
    if (isUnknown) {
      return
    }
    const isNewRemoteTarget =
      remoteTargetKey !== null && !observedRemoteTargetKeysRef.current.has(remoteTargetKey)
    // Remember every target seen by this mount so A → B → A does not repeatedly spawn probes for empty hosts.
    if (remoteTargetKey !== null) {
      observedRemoteTargetKeysRef.current.add(remoteTargetKey)
    }
    const state = useAppStore.getState()
    if (targetKind === 'ssh' && targetId) {
      if (detectedIds === null) {
        void state.ensureRemoteDetectedAgents(targetId)
      } else if (isNewRemoteTarget && detectedIds.length > 0) {
        // Refresh once when a new launch surface observes a host; cached inventory may predate installs.
        void state.refreshRemoteDetectedAgents(targetId)
      } else if (isNewRemoteTarget) {
        // Empty results are intentionally retryable through the normal probe.
        void state.ensureRemoteDetectedAgents(targetId)
      }
    } else if (targetKind === 'runtime' && targetId) {
      if (detectedIds === null) {
        void state.ensureRuntimeDetectedAgents(targetId, runtimeWorktreeId)
      } else if (isNewRemoteTarget && detectedIds.length > 0) {
        // Refresh once when a new launch surface observes a host; cached inventory may predate installs.
        void state.refreshRuntimeDetectedAgents(targetId, runtimeWorktreeId)
      } else if (isNewRemoteTarget) {
        // Empty results are intentionally retryable through the normal probe.
        void state.ensureRuntimeDetectedAgents(targetId, runtimeWorktreeId)
      }
    } else {
      if (detectedIds === null && !localProbePending) {
        void state.ensureDetectedAgents(localWorktreeId)
      }
    }
  }, [
    isUnknown,
    targetKind,
    targetId,
    remoteTargetKey,
    pairingRevision,
    detectedIds,
    localProbePending,
    localWorktreeId,
    runtimeWorktreeId,
    localContextKey
  ])

  return { detectedIds, isLoading, detectionFailed, isRefreshing, needsServerUpdate, refresh }
}
