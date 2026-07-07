/* eslint-disable max-lines -- Why: repo metadata hooks share TTL caches and
Linear/GitHub cache invalidation entrypoints used by the issue dialog. */
/* oxlint-disable react-doctor/no-adjust-state-on-prop-change -- Why: issue metadata hooks clear stale rows and track loading while async provider cache requests are in flight. */
import { useEffect, useRef, useState } from 'react'
import { callRuntimeRpc, getActiveRuntimeTarget } from '@/runtime/runtime-rpc-client'
import {
  linearTeamLabels,
  linearTeamMembers,
  linearTeamStates,
  type RuntimeLinearSettings
} from '@/runtime/runtime-linear-client'
import type {
  GitHubAssignableUser,
  GitHubViewerRepoPermission,
  LinearWorkflowState,
  LinearLabel,
  LinearMember
} from '../../../shared/types'
import { getTaskSourceRuntimeSettings } from '../../../shared/task-source-context'
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

type GitHubMetadataOptions = {
  runtimeEnvironmentId?: string | null
  activeRuntimeEnvironmentId?: string | null
}

// ─── GitHub ────────────────────────────────────────────────

const ghLabelStore = createMetadataRequestStore<string[]>()
const ghAssigneeStore = createMetadataRequestStore<GitHubAssignableUser[]>()
const ghViewerPermissionStore = createMetadataRequestStore<GitHubViewerRepoPermission | null>()
const ghViewerLoginStore = createMetadataRequestStore<string | null>()

/**
 * Authenticated gh viewer login, local host only. Runtime/SSH targets have no
 * viewer RPC yet, so callers get `null` there and must treat the author-based
 * permission exceptions as unknown (gate conservatively).
 */
export function useGitHubViewerLogin(options?: GitHubMetadataOptions): string | null {
  const [login, setLogin] = useState<string | null>(null)
  const runtimeEnvironmentId =
    options?.runtimeEnvironmentId?.trim() || options?.activeRuntimeEnvironmentId?.trim() || null

  useEffect(() => {
    if (runtimeEnvironmentId) {
      setLogin(null)
      return
    }
    const cached = getFreshMetadata(ghViewerLoginStore, 'local')
    if (cached) {
      setLogin(cached.data)
      return
    }
    let cancelled = false
    loadMetadata(ghViewerLoginStore, 'local', () =>
      window.api.gh.viewer().then((viewer) => {
        const candidate = viewer as { login?: unknown } | null
        return typeof candidate?.login === 'string' ? candidate.login : null
      })
    )
      .then((data) => {
        if (!cancelled) {
          setLogin(data)
        }
      })
      .catch(() => {
        if (!cancelled) {
          setLogin(null)
        }
      })
    return () => {
      cancelled = true
    }
  }, [runtimeEnvironmentId])

  return login
}

/**
 * Highest permission the viewer holds on the repo that issue mutations for
 * this repoPath/override would target. `null` data = unknown (fetch failed) —
 * callers must fail open and keep controls interactive.
 */
export function useRepoViewerPermission(
  repoPath: string | null,
  repoId?: string | null,
  overrideOwnerRepo?: { owner: string; repo: string } | null,
  options?: GitHubMetadataOptions
): MetadataState<GitHubViewerRepoPermission | null> {
  const [state, setState] = useState<MetadataState<GitHubViewerRepoPermission | null>>({
    data: null,
    loading: false,
    error: null
  })
  const activeKeyRef = useRef<string | null>(null)
  const overrideOwner = overrideOwnerRepo?.owner ?? null
  const overrideRepo = overrideOwnerRepo?.repo ?? null

  useEffect(() => {
    if (!repoPath && !repoId) {
      return
    }
    const runtimeEnvironmentId =
      options?.runtimeEnvironmentId?.trim() || options?.activeRuntimeEnvironmentId?.trim() || null
    const repoSelector = repoId ?? repoPath ?? ''
    const overridePart = overrideOwner && overrideRepo ? `@${overrideOwner}/${overrideRepo}` : ''
    // Why: SSH/runtime metadata must not reuse host-path cache entries; the same
    // repo id may resolve through a different credential/runtime boundary.
    const cacheKey = runtimeEnvironmentId
      ? `runtime:${runtimeEnvironmentId}:${repoSelector}${overridePart}`
      : `${repoSelector}${overridePart}`
    const cached = getFreshMetadata(ghViewerPermissionStore, cacheKey)
    if (cached) {
      if (activeKeyRef.current !== cacheKey) {
        setState({ data: cached.data, loading: false, error: null })
        activeKeyRef.current = cacheKey
      }
      return
    }

    activeKeyRef.current = cacheKey
    const requestKey = cacheKey
    setState({ data: null, loading: true, error: null })
    loadMetadata(ghViewerPermissionStore, cacheKey, () =>
      (runtimeEnvironmentId
        ? callRuntimeRpc<{ permission: GitHubViewerRepoPermission } | null>(
            { kind: 'environment', environmentId: runtimeEnvironmentId },
            'github.viewerRepoPermission',
            {
              repo: repoSelector,
              ...(overrideOwner && overrideRepo
                ? { owner: overrideOwner, ownerRepo: overrideRepo }
                : {})
            },
            { timeoutMs: 15_000 }
          )
        : window.api.gh.viewerRepoPermission({
            repoPath: repoPath ?? '',
            repoId: repoId ?? undefined,
            ...(overrideOwner && overrideRepo ? { owner: overrideOwner, repo: overrideRepo } : {})
          })
      ).then((result) => result?.permission ?? null)
    )
      .then((data) => {
        if (activeKeyRef.current !== requestKey) {
          return
        }
        setState({ data, loading: false, error: null })
      })
      .catch(() => {
        if (activeKeyRef.current !== requestKey) {
          return
        }
        activeKeyRef.current = null
        // Fail open: unknown permission keeps controls interactive.
        setState({ data: null, loading: false, error: null })
      })
  }, [
    repoPath,
    repoId,
    overrideOwner,
    overrideRepo,
    options?.runtimeEnvironmentId,
    options?.activeRuntimeEnvironmentId
  ])

  return state
}

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
  settings?: RuntimeLinearSettings,
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
  settings?: RuntimeLinearSettings,
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
