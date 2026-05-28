/* eslint-disable max-lines -- Why: repo metadata hooks share TTL caches and
Linear/GitHub cache invalidation entrypoints used by the issue dialog. */
import { useEffect, useRef, useState } from 'react'
import { getActiveRuntimeTarget } from '@/runtime/runtime-rpc-client'
import {
  linearTeamLabels,
  linearTeamMembers,
  linearTeamStates
} from '@/runtime/runtime-linear-client'
import type {
  GitHubAssignableUser,
  GlobalSettings,
  LinearWorkflowState,
  LinearLabel,
  LinearMember
} from '../../../shared/types'
import {
  clearMetadataRequestStore,
  createMetadataRequestStore,
  getFreshMetadata,
  loadMetadata
} from './metadata-request-cache'

type MetadataState<T> = {
  data: T
  loading: boolean
  error: string | null
}

// ─── GitHub ────────────────────────────────────────────────

const ghLabelStore = createMetadataRequestStore<string[]>()
const ghAssigneeStore = createMetadataRequestStore<GitHubAssignableUser[]>()

export function useRepoLabels(
  repoPath: string | null,
  repoId?: string | null
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
    const cacheKey = repoId ?? repoPath ?? ''
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
      window.api.gh
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
  }, [repoPath, repoId])

  return state
}

export function useRepoAssignees(
  repoPath: string | null,
  repoId?: string | null
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
    const cacheKey = repoId ?? repoPath ?? ''
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
      window.api.gh
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
  }, [repoPath, repoId])

  return state
}

// ─── Linear ────────────────────────────────────────────────

const linearStateStore = createMetadataRequestStore<LinearWorkflowState[]>()
const linearLabelStore = createMetadataRequestStore<LinearLabel[]>()
const linearMemberStore = createMetadataRequestStore<LinearMember[]>()

function linearMetadataCacheKey(
  teamId: string,
  settings: Pick<GlobalSettings, 'activeRuntimeEnvironmentId'> | null | undefined,
  workspaceId?: string | null
): string {
  const target = getActiveRuntimeTarget(settings)
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
  settings?: Pick<GlobalSettings, 'activeRuntimeEnvironmentId'> | null,
  workspaceId?: string | null
): MetadataState<LinearWorkflowState[]> {
  const [state, setState] = useState<MetadataState<LinearWorkflowState[]>>({
    data: [],
    loading: false,
    error: null
  })
  const activeKeyRef = useRef<string | null>(null)

  useEffect(() => {
    if (!teamId) {
      return
    }

    const cacheKey = linearMetadataCacheKey(teamId, settings, workspaceId)
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
      linearTeamStates(settings, teamId, workspaceId).then(
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
  }, [settings, teamId, workspaceId])

  return state
}

export function useTeamLabels(
  teamId: string | null,
  settings?: Pick<GlobalSettings, 'activeRuntimeEnvironmentId'> | null,
  workspaceId?: string | null
): MetadataState<LinearLabel[]> {
  const [state, setState] = useState<MetadataState<LinearLabel[]>>({
    data: [],
    loading: false,
    error: null
  })
  const activeKeyRef = useRef<string | null>(null)

  useEffect(() => {
    if (!teamId) {
      return
    }

    const cacheKey = linearMetadataCacheKey(teamId, settings, workspaceId)
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
      linearTeamLabels(settings, teamId, workspaceId).then((labels) => labels as LinearLabel[])
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
  }, [settings, teamId, workspaceId])

  return state
}

export function useTeamMembers(
  teamId: string | null,
  settings?: Pick<GlobalSettings, 'activeRuntimeEnvironmentId'> | null,
  workspaceId?: string | null
): MetadataState<LinearMember[]> {
  const [state, setState] = useState<MetadataState<LinearMember[]>>({
    data: [],
    loading: false,
    error: null
  })
  const activeKeyRef = useRef<string | null>(null)

  useEffect(() => {
    if (!teamId) {
      return
    }

    const cacheKey = linearMetadataCacheKey(teamId, settings, workspaceId)
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
      linearTeamMembers(settings, teamId, workspaceId).then((members) => members as LinearMember[])
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
  }, [settings, teamId, workspaceId])

  return state
}

export { useImmediateMutation } from './useImmediateMutation'
