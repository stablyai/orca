import { useEffect, useMemo, useRef, useState } from 'react'
import { callRuntimeRpc, getActiveRuntimeTarget } from '@/runtime/runtime-rpc-client'
import {
  linearTeamLabels,
  linearTeamMembers,
  linearTeamStates
} from '@/runtime/runtime-linear-project-client'
import type { RuntimeLinearSettings } from '@/runtime/runtime-linear-client'
import type { GitHubAssignableUser } from '../../../shared/github/pull-request-types'
import type {
  LinearLabel,
  LinearMember,
  LinearWorkflowState
} from '../../../shared/linear/workspace-types'
import { getTaskSourceRuntimeSettings } from '../../../shared/task-source-context'
import { unionLinearMetadataById } from '../components/linear-issue-attribute-filter-team-ids'
import {
  clearMetadataRequestStore,
  createMetadataRequestStore,
  getFreshMetadata,
  loadMetadata,
  type MetadataRequestStore
} from './metadata-request-cache'
import { useMetadataListRequest, type MetadataListState } from './useMetadataListRequest'

type GitHubMetadataOptions = {
  runtimeEnvironmentId?: string | null
  activeRuntimeEnvironmentId?: string | null
}

const ghLabelStore = createMetadataRequestStore<string[]>()
const ghAssigneeStore = createMetadataRequestStore<GitHubAssignableUser[]>()

export function useRepoLabels(
  repoPath: string | null,
  repoId?: string | null,
  options?: GitHubMetadataOptions
): MetadataListState<string> {
  const runtimeEnvironmentId =
    options?.runtimeEnvironmentId?.trim() || options?.activeRuntimeEnvironmentId?.trim() || null
  const repoSelector = repoId ?? repoPath ?? ''
  const cacheKey =
    repoPath || repoId
      ? runtimeEnvironmentId
        ? `runtime:${runtimeEnvironmentId}:${repoSelector}`
        : repoSelector
      : null

  return useMetadataListRequest({
    cacheKey,
    store: ghLabelStore,
    errorFallback: 'Failed to load labels',
    load: () =>
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
  })
}

export function useRepoAssignees(
  repoPath: string | null,
  repoId?: string | null,
  options?: GitHubMetadataOptions
): MetadataListState<GitHubAssignableUser> {
  const runtimeEnvironmentId =
    options?.runtimeEnvironmentId?.trim() || options?.activeRuntimeEnvironmentId?.trim() || null
  const repoSelector = repoId ?? repoPath ?? ''
  const cacheKey =
    repoPath || repoId
      ? runtimeEnvironmentId
        ? `runtime:${runtimeEnvironmentId}:${repoSelector}`
        : repoSelector
      : null

  return useMetadataListRequest({
    cacheKey,
    store: ghAssigneeStore,
    errorFallback: 'Failed to load assignees',
    load: () =>
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
  })
}

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

export function useTeamStates(
  teamId: string | null,
  settings?: RuntimeLinearSettings,
  workspaceId?: string | null
): MetadataListState<LinearWorkflowState> {
  const selectedTeamId = teamId ?? ''
  return useMetadataListRequest({
    cacheKey: selectedTeamId ? linearMetadataCacheKey(selectedTeamId, settings, workspaceId) : null,
    store: linearStateStore,
    load: () => loadTeamStates(settings, selectedTeamId, workspaceId),
    errorFallback: 'Failed to load states'
  })
}

export function useTeamLabels(
  teamId: string | null,
  settings?: RuntimeLinearSettings,
  workspaceId?: string | null
): MetadataListState<LinearLabel> {
  const selectedTeamId = teamId ?? ''
  return useMetadataListRequest({
    cacheKey: selectedTeamId ? linearMetadataCacheKey(selectedTeamId, settings, workspaceId) : null,
    store: linearLabelStore,
    load: () => loadTeamLabels(settings, selectedTeamId, workspaceId),
    errorFallback: 'Failed to load labels'
  })
}

export function useTeamMembers(
  teamId: string | null,
  settings?: RuntimeLinearSettings,
  workspaceId?: string | null
): MetadataListState<LinearMember> {
  const selectedTeamId = teamId ?? ''
  return useMetadataListRequest({
    cacheKey: selectedTeamId ? linearMetadataCacheKey(selectedTeamId, settings, workspaceId) : null,
    store: linearMemberStore,
    load: () => loadTeamMembers(settings, selectedTeamId, workspaceId),
    errorFallback: 'Failed to load members'
  })
}

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
): MetadataListState<T> {
  const [state, setState] = useState<MetadataListState<T>>({
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
    const cachedGroups = stableTeamIds.map(
      (teamId) =>
        getFreshMetadata(store, linearMetadataCacheKey(teamId, settingsRef.current, workspaceId))
          ?.data
    )
    if (cachedGroups.every((group): group is T[] => group !== undefined)) {
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
      stableTeamIds.map((teamId) => {
        const cacheKey = linearMetadataCacheKey(teamId, settingsRef.current, workspaceId)
        return loadMetadata(store, cacheKey, () =>
          loadTeam(settingsRef.current, teamId, workspaceId)
        )
      })
    )
      .then((groups) => {
        if (activeKeyRef.current !== requestKey) {
          return
        }
        setState({
          data: unionLinearMetadataById(groups),
          loading: false,
          error: null
        })
      })
      .catch((err) => {
        if (activeKeyRef.current !== requestKey) {
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

export function useTeamsStates(
  teamIds: readonly string[],
  settings?: RuntimeLinearSettings,
  workspaceId?: string | null
): MetadataListState<LinearWorkflowState> {
  return useTeamsMetadataList(
    teamIds,
    settings,
    workspaceId,
    linearStateStore,
    loadTeamStates,
    'Failed to load states'
  )
}

export function useTeamsLabels(
  teamIds: readonly string[],
  settings?: RuntimeLinearSettings,
  workspaceId?: string | null
): MetadataListState<LinearLabel> {
  return useTeamsMetadataList(
    teamIds,
    settings,
    workspaceId,
    linearLabelStore,
    loadTeamLabels,
    'Failed to load labels'
  )
}

export function useTeamsMembers(
  teamIds: readonly string[],
  settings?: RuntimeLinearSettings,
  workspaceId?: string | null
): MetadataListState<LinearMember> {
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
