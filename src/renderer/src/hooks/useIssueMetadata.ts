/* eslint-disable max-lines -- Why: repo metadata hooks share TTL caches and
Linear/GitHub cache invalidation entrypoints used by the issue dialog. */
/* oxlint-disable react-doctor/no-adjust-state-on-prop-change -- Why: issue metadata hooks clear stale rows and track loading while async provider cache requests are in flight. */
import { useEffect, useMemo, useRef, useState } from 'react'
import { callRuntimeRpc, getActiveRuntimeTarget } from '@/runtime/runtime-rpc-client'
import {
  linearTeamLabels,
  linearTeamMembers,
  linearTeamStates,
  type RuntimeLinearSettings
} from '@/runtime/runtime-linear-client'
import type {
  GitHubAssignableUser,
  LinearWorkflowState,
  LinearLabel,
  LinearMember
} from '../../../shared/types'
import { getTaskSourceRuntimeSettings } from '../../../shared/task-source-context'
import { unionLinearMetadataById } from '../components/linear-issue-attribute-filter-team-ids'
import {
  clearMetadataRequestStore,
  createMetadataRequestStore,
  getFreshMetadata,
  loadMetadata,
  type MetadataRequestStore
} from './metadata-request-cache'

type MetadataState<T> = {
  data: T
  loading: boolean
  error: string | null
}

type GitHubMetadataOptions = {
  runtimeEnvironmentId?: string | null
  activeRuntimeEnvironmentId?: string | null
}

// ─── GitHub ────────────────────────────────────────────────

const ghLabelStore = createMetadataRequestStore<string[]>()
const ghAssigneeStore = createMetadataRequestStore<GitHubAssignableUser[]>()

export function useRepoLabels(
  repoPath: string | null,
  repoId?: string | null,
  options?: GitHubMetadataOptions
): MetadataState<string[]> {
  const [state, setState] = useState<MetadataState<string[]>>({
    data: [],
    loading: false,
    error: null
  })
  const activeKeyRef = useRef<string | null>(null)

  useEffect(() => {
    if (!repoPath && !repoId) {
      return
    }
    const runtimeEnvironmentId =
      options?.runtimeEnvironmentId?.trim() || options?.activeRuntimeEnvironmentId?.trim() || null
    const repoSelector = repoId ?? repoPath ?? ''
    // Why: SSH/runtime metadata must not reuse host-path cache entries; the same
    // repo id may resolve through a different credential/runtime boundary.
    const cacheKey = runtimeEnvironmentId
      ? `runtime:${runtimeEnvironmentId}:${repoSelector}`
      : repoSelector
    const cached = getFreshMetadata(ghLabelStore, cacheKey)
    if (cached) {
      if (activeKeyRef.current !== cacheKey) {
        setState({ data: cached.data, loading: false, error: null })
        activeKeyRef.current = cacheKey
      }
      return
    }

    activeKeyRef.current = cacheKey
    const requestKey = cacheKey
    setState((s) => ({
      ...s,
      data: s.data.length ? ([] as typeof s.data) : s.data,
      loading: true,
      error: null
    }))
    loadMetadata(ghLabelStore, cacheKey, () =>
      runtimeEnvironmentId
        ? callRuntimeRpc<string[]>(
            { kind: 'environment', environmentId: runtimeEnvironmentId },
            'github.listLabels',
            { repo: repoSelector },
            { timeoutMs: 15_000 }
          )
        : window.api.gh
            .listLabels({ repoPath: repoPath ?? '', repoId: repoId ?? undefined })
            .then((labels) => labels as string[])
    )
      .then((data) => {
        if (activeKeyRef.current !== requestKey) {
          return
        }
        setState({ data, loading: false, error: null })
      })
      .catch((err) => {
        if (activeKeyRef.current !== requestKey) {
          return
        }
        activeKeyRef.current = null
        setState((s) => ({
          ...s,
          loading: false,
          error: err instanceof Error ? err.message : 'Failed to load labels'
        }))
      })
  }, [repoPath, repoId, options?.runtimeEnvironmentId, options?.activeRuntimeEnvironmentId])

  return state
}

export function useRepoAssignees(
  repoPath: string | null,
  repoId?: string | null,
  options?: GitHubMetadataOptions
): MetadataState<GitHubAssignableUser[]> {
  const [state, setState] = useState<MetadataState<GitHubAssignableUser[]>>({
    data: [],
    loading: false,
    error: null
  })
  const activeKeyRef = useRef<string | null>(null)

  useEffect(() => {
    if (!repoPath && !repoId) {
      return
    }
    const runtimeEnvironmentId =
      options?.runtimeEnvironmentId?.trim() || options?.activeRuntimeEnvironmentId?.trim() || null
    const repoSelector = repoId ?? repoPath ?? ''
    // Why: SSH/runtime metadata must not reuse host-path cache entries; the same
    // repo id may resolve through a different credential/runtime boundary.
    const cacheKey = runtimeEnvironmentId
      ? `runtime:${runtimeEnvironmentId}:${repoSelector}`
      : repoSelector
    const cached = getFreshMetadata(ghAssigneeStore, cacheKey)
    if (cached) {
      if (activeKeyRef.current !== cacheKey) {
        setState({ data: cached.data, loading: false, error: null })
        activeKeyRef.current = cacheKey
      }
      return
    }

    activeKeyRef.current = cacheKey
    const requestKey = cacheKey
    setState((s) => ({
      ...s,
      data: s.data.length ? ([] as typeof s.data) : s.data,
      loading: true,
      error: null
    }))
    loadMetadata(ghAssigneeStore, cacheKey, () =>
      runtimeEnvironmentId
        ? callRuntimeRpc<GitHubAssignableUser[]>(
            { kind: 'environment', environmentId: runtimeEnvironmentId },
            'github.listAssignableUsers',
            { repo: repoSelector },
            { timeoutMs: 15_000 }
          )
        : window.api.gh
            .listAssignableUsers({ repoPath: repoPath ?? '', repoId: repoId ?? undefined })
            .then((users) => users as GitHubAssignableUser[])
    )
      .then((data) => {
        if (activeKeyRef.current !== requestKey) {
          return
        }
        setState({ data, loading: false, error: null })
      })
      .catch((err) => {
        if (activeKeyRef.current !== requestKey) {
          return
        }
        activeKeyRef.current = null
        setState((s) => ({
          ...s,
          loading: false,
          error: err instanceof Error ? err.message : 'Failed to load assignees'
        }))
      })
  }, [repoPath, repoId, options?.runtimeEnvironmentId, options?.activeRuntimeEnvironmentId])

  return state
}

// ─── Linear ────────────────────────────────────────────────

const linearStateStore = createMetadataRequestStore<LinearWorkflowState[]>()
const linearLabelStore = createMetadataRequestStore<LinearLabel[]>()
const linearMemberStore = createMetadataRequestStore<LinearMember[]>()

function linearMetadataCacheKey(
  teamId: string,
  settings: RuntimeLinearSettings,
  workspaceId?: string | null
): string {
  const runtimeSettings =
    settings && 'kind' in settings ? getTaskSourceRuntimeSettings(settings) : settings
  const target = getActiveRuntimeTarget(runtimeSettings)
  const workspaceKey = workspaceId ?? 'selected'
  return target.kind === 'environment'
    ? `runtime:${target.environmentId}:${workspaceKey}:${teamId}`
    : `${workspaceKey}:${teamId}`
}

export function clearLinearMetadataCache(): void {
  clearMetadataRequestStore(linearStateStore)
  clearMetadataRequestStore(linearLabelStore)
  clearMetadataRequestStore(linearMemberStore)
}

export function clearGitHubMetadataCache(): void {
  clearMetadataRequestStore(ghLabelStore)
  clearMetadataRequestStore(ghAssigneeStore)
}

export function useTeamStates(
  teamId: string | null,
  settings?: RuntimeLinearSettings,
  workspaceId?: string | null
): MetadataState<LinearWorkflowState[]> {
  const [state, setState] = useState<MetadataState<LinearWorkflowState[]>>({
    data: [],
    loading: false,
    error: null
  })
  const activeKeyRef = useRef<string | null>(null)
  // Why: parents can pass a fresh settings object each render; keying the effect
  // on the derived cache key keeps a failure's setState from re-arming the fetch
  // in a render-paced loop. The ref carries the latest settings for the call.
  const settingsRef = useRef(settings)
  settingsRef.current = settings
  const cacheKey = teamId ? linearMetadataCacheKey(teamId, settings, workspaceId) : null

  useEffect(() => {
    if (!teamId || !cacheKey) {
      return
    }

    const cached = getFreshMetadata(linearStateStore, cacheKey)
    if (cached) {
      if (activeKeyRef.current !== cacheKey) {
        setState({ data: cached.data, loading: false, error: null })
        activeKeyRef.current = cacheKey
      }
      return
    }

    activeKeyRef.current = cacheKey
    const requestKey = cacheKey
    setState((s) => ({
      ...s,
      data: s.data.length ? ([] as typeof s.data) : s.data,
      loading: true,
      error: null
    }))
    loadMetadata(linearStateStore, cacheKey, () =>
      linearTeamStates(settingsRef.current, teamId, workspaceId).then(
        (states) => states as LinearWorkflowState[]
      )
    )
      .then((data) => {
        if (activeKeyRef.current !== requestKey) {
          return
        }
        setState({ data, loading: false, error: null })
      })
      .catch((err) => {
        if (activeKeyRef.current !== requestKey) {
          return
        }
        activeKeyRef.current = null
        setState((s) => ({
          ...s,
          loading: false,
          error: err instanceof Error ? err.message : 'Failed to load states'
        }))
      })
  }, [cacheKey, teamId, workspaceId])

  return state
}

export function useTeamLabels(
  teamId: string | null,
  settings?: RuntimeLinearSettings,
  workspaceId?: string | null
): MetadataState<LinearLabel[]> {
  const [state, setState] = useState<MetadataState<LinearLabel[]>>({
    data: [],
    loading: false,
    error: null
  })
  const activeKeyRef = useRef<string | null>(null)
  // Why: see useTeamStates — cache-key deps + latest-settings ref stop the
  // failure-setState render loop.
  const settingsRef = useRef(settings)
  settingsRef.current = settings
  const cacheKey = teamId ? linearMetadataCacheKey(teamId, settings, workspaceId) : null

  useEffect(() => {
    if (!teamId || !cacheKey) {
      return
    }

    const cached = getFreshMetadata(linearLabelStore, cacheKey)
    if (cached) {
      if (activeKeyRef.current !== cacheKey) {
        setState({ data: cached.data, loading: false, error: null })
        activeKeyRef.current = cacheKey
      }
      return
    }

    activeKeyRef.current = cacheKey
    const requestKey = cacheKey
    setState((s) => ({
      ...s,
      data: s.data.length ? ([] as typeof s.data) : s.data,
      loading: true,
      error: null
    }))
    loadMetadata(linearLabelStore, cacheKey, () =>
      linearTeamLabels(settingsRef.current, teamId, workspaceId).then(
        (labels) => labels as LinearLabel[]
      )
    )
      .then((data) => {
        if (activeKeyRef.current !== requestKey) {
          return
        }
        setState({ data, loading: false, error: null })
      })
      .catch((err) => {
        if (activeKeyRef.current !== requestKey) {
          return
        }
        activeKeyRef.current = null
        setState((s) => ({
          ...s,
          loading: false,
          error: err instanceof Error ? err.message : 'Failed to load labels'
        }))
      })
  }, [cacheKey, teamId, workspaceId])

  return state
}

export function useTeamMembers(
  teamId: string | null,
  settings?: RuntimeLinearSettings,
  workspaceId?: string | null
): MetadataState<LinearMember[]> {
  const [state, setState] = useState<MetadataState<LinearMember[]>>({
    data: [],
    loading: false,
    error: null
  })
  const activeKeyRef = useRef<string | null>(null)
  // Why: see useTeamStates — cache-key deps + latest-settings ref stop the
  // failure-setState render loop.
  const settingsRef = useRef(settings)
  settingsRef.current = settings
  const cacheKey = teamId ? linearMetadataCacheKey(teamId, settings, workspaceId) : null

  useEffect(() => {
    if (!teamId || !cacheKey) {
      return
    }

    const cached = getFreshMetadata(linearMemberStore, cacheKey)
    if (cached) {
      if (activeKeyRef.current !== cacheKey) {
        setState({ data: cached.data, loading: false, error: null })
        activeKeyRef.current = cacheKey
      }
      return
    }

    activeKeyRef.current = cacheKey
    const requestKey = cacheKey
    setState((s) => ({
      ...s,
      data: s.data.length ? ([] as typeof s.data) : s.data,
      loading: true,
      error: null
    }))
    loadMetadata(linearMemberStore, cacheKey, () =>
      linearTeamMembers(settingsRef.current, teamId, workspaceId).then(
        (members) => members as LinearMember[]
      )
    )
      .then((data) => {
        if (activeKeyRef.current !== requestKey) {
          return
        }
        setState({ data, loading: false, error: null })
      })
      .catch((err) => {
        if (activeKeyRef.current !== requestKey) {
          return
        }
        activeKeyRef.current = null
        setState((s) => ({
          ...s,
          loading: false,
          error: err instanceof Error ? err.message : 'Failed to load members'
        }))
      })
  }, [cacheKey, teamId, workspaceId])

  return state
}

/**
 * Load Linear team metadata for every selected team and union by id (#8739).
 * Reuses the same per-team cache stores as the single-team hooks.
 */
function useTeamsMetadataList<T extends { id: string }>(
  teamIds: readonly string[],
  settings: RuntimeLinearSettings | undefined,
  workspaceId: string | null | undefined,
  store: MetadataRequestStore<T[]>,
  loadTeam: (
    settings: RuntimeLinearSettings | undefined,
    teamId: string,
    workspaceId: string | null | undefined
  ) => Promise<T[]>,
  errorFallback: string
): MetadataState<T[]> {
  const [state, setState] = useState<MetadataState<T[]>>({
    data: [],
    loading: false,
    error: null
  })
  const activeKeyRef = useRef<string | null>(null)
  const settingsRef = useRef(settings)
  settingsRef.current = settings

  // Why: parents often pass a fresh teamIds array each render; key on joined ids.
  const teamIdsKey = teamIds.filter((id) => id.trim().length > 0).join('\0')
  const stableTeamIds = useMemo(
    () => [...new Set(teamIdsKey.length === 0 ? [] : teamIdsKey.split('\0'))],
    [teamIdsKey]
  )

  // Why: recompute each render (like useTeamStates cacheKey) so runtime target changes re-key.
  const requestKey =
    stableTeamIds.length === 0
      ? null
      : stableTeamIds
          .map((teamId) => linearMetadataCacheKey(teamId, settings, workspaceId))
          .join('|')

  useEffect(() => {
    if (!requestKey || stableTeamIds.length === 0) {
      activeKeyRef.current = null
      setState({ data: [], loading: false, error: null })
      return
    }

    activeKeyRef.current = requestKey
    const capturedKey = requestKey
    const teams = stableTeamIds

    // Fast path: every team still fresh in cache → union synchronously.
    const cachedGroups: T[][] = []
    let allCached = true
    for (const teamId of teams) {
      const cacheKey = linearMetadataCacheKey(teamId, settingsRef.current, workspaceId)
      const cached = getFreshMetadata(store, cacheKey)
      if (!cached) {
        allCached = false
        break
      }
      cachedGroups.push(cached.data)
    }
    if (allCached) {
      setState({ data: unionLinearMetadataById(cachedGroups), loading: false, error: null })
      return
    }

    setState((s) => ({
      ...s,
      data: s.data.length ? ([] as typeof s.data) : s.data,
      loading: true,
      error: null
    }))

    void Promise.all(
      teams.map((teamId) => {
        const cacheKey = linearMetadataCacheKey(teamId, settingsRef.current, workspaceId)
        return loadMetadata(store, cacheKey, () =>
          loadTeam(settingsRef.current, teamId, workspaceId)
        )
      })
    )
      .then((groups) => {
        if (activeKeyRef.current !== capturedKey) {
          return
        }
        setState({
          data: unionLinearMetadataById(groups),
          loading: false,
          error: null
        })
      })
      .catch((err) => {
        if (activeKeyRef.current !== capturedKey) {
          return
        }
        activeKeyRef.current = null
        setState((s) => ({
          ...s,
          loading: false,
          error: err instanceof Error ? err.message : errorFallback
        }))
      })
  }, [requestKey, stableTeamIds, workspaceId, store, loadTeam, errorFallback])

  return state
}

const loadTeamStates = (
  settings: RuntimeLinearSettings | undefined,
  teamId: string,
  workspaceId: string | null | undefined
): Promise<LinearWorkflowState[]> =>
  linearTeamStates(settings, teamId, workspaceId).then((states) => states as LinearWorkflowState[])

const loadTeamLabels = (
  settings: RuntimeLinearSettings | undefined,
  teamId: string,
  workspaceId: string | null | undefined
): Promise<LinearLabel[]> =>
  linearTeamLabels(settings, teamId, workspaceId).then((labels) => labels as LinearLabel[])

const loadTeamMembers = (
  settings: RuntimeLinearSettings | undefined,
  teamId: string,
  workspaceId: string | null | undefined
): Promise<LinearMember[]> =>
  linearTeamMembers(settings, teamId, workspaceId).then((members) => members as LinearMember[])

/** Union of workflow states for every selected Linear team (multi-team filters). */
export function useTeamsStates(
  teamIds: readonly string[],
  settings?: RuntimeLinearSettings,
  workspaceId?: string | null
): MetadataState<LinearWorkflowState[]> {
  return useTeamsMetadataList(
    teamIds,
    settings,
    workspaceId,
    linearStateStore,
    loadTeamStates,
    'Failed to load states'
  )
}

/** Union of labels for every selected Linear team (multi-team filters). */
export function useTeamsLabels(
  teamIds: readonly string[],
  settings?: RuntimeLinearSettings,
  workspaceId?: string | null
): MetadataState<LinearLabel[]> {
  return useTeamsMetadataList(
    teamIds,
    settings,
    workspaceId,
    linearLabelStore,
    loadTeamLabels,
    'Failed to load labels'
  )
}

/** Union of members for every selected Linear team (multi-team filters). */
export function useTeamsMembers(
  teamIds: readonly string[],
  settings?: RuntimeLinearSettings,
  workspaceId?: string | null
): MetadataState<LinearMember[]> {
  return useTeamsMetadataList(
    teamIds,
    settings,
    workspaceId,
    linearMemberStore,
    loadTeamMembers,
    'Failed to load members'
  )
}

export { useImmediateMutation } from './useImmediateMutation'
