// Why: when the dialog opens for a Project row whose repo differs from the
// active workspace, label/assignee lookups must target the row's repo via
// slug-addressed IPCs (`listLabelsBySlug` / `listAssignableUsersBySlug`),
// not via the workspace path. These hooks live in their own module so the
// existing repoPath-keyed hooks stay focused on the local-workspace flow
// and so this file remains under the lint line cap.
/* oxlint-disable react-doctor/no-adjust-state-on-prop-change -- Why: slug metadata hooks clear stale rows and track loading while async provider cache requests are in flight. */
import { useEffect, useRef, useState } from 'react'
import { callRuntimeRpc, getActiveRuntimeTarget } from '@/runtime/runtime-rpc-client'
import type { GitHubAssignableUser, GlobalSettings } from '../../../shared/types'
import type {
  ListAssignableUsersBySlugResult,
  ListLabelsBySlugResult
} from '../../../shared/github-project-types'
import {
  clearMetadataRequestStore,
  createMetadataRequestStore,
  getFreshMetadata,
  loadMetadata
} from './metadata-request-cache'
import { githubRepoIdentityKey } from '../../../shared/github-repository-identity-key'
import { githubProjectHost } from '../../../shared/github-project-identity'

type MetadataState<T> = {
  data: T
  loading: boolean
  error: string | null
}

const slugLabelStore = createMetadataRequestStore<string[]>()
const slugAssigneeStore = createMetadataRequestStore<GitHubAssignableUser[]>()

export function clearGitHubSlugMetadataCache(): void {
  clearMetadataRequestStore(slugLabelStore)
  clearMetadataRequestStore(slugAssigneeStore)
}

export function useRepoLabelsBySlug(
  owner: string | null,
  repo: string | null,
  settings?: Pick<GlobalSettings, 'activeRuntimeEnvironmentId'> | null,
  host?: string
): MetadataState<string[]> {
  const [state, setState] = useState<MetadataState<string[]>>({
    data: [],
    loading: false,
    error: null
  })
  const activeKeyRef = useRef<string | null>(null)
  // Why: parent selectors can pass a fresh settings object each render; keying
  // the effect on the primitive env id keeps a failure's setState from re-running
  // the effect and re-issuing the fetch in a render-paced loop (same class as
  // the seedKey stabilization below).
  const activeRuntimeEnvironmentId = settings?.activeRuntimeEnvironmentId ?? null

  useEffect(() => {
    if (!owner || !repo) {
      return
    }
    const target = getActiveRuntimeTarget({ activeRuntimeEnvironmentId })
    const repositoryKey = githubRepoIdentityKey({ owner, repo, host })
    const key =
      target.kind === 'environment'
        ? `runtime:${target.environmentId}:${repositoryKey}`
        : repositoryKey

    const cached = getFreshMetadata(slugLabelStore, key)
    if (cached) {
      if (activeKeyRef.current !== key) {
        setState({ data: cached.data, loading: false, error: null })
      }
      activeKeyRef.current = key
      return
    }

    if (activeKeyRef.current === key) {
      return
    }
    activeKeyRef.current = key
    const requestKey = key
    setState((s) => ({
      ...s,
      data: s.data.length ? ([] as typeof s.data) : s.data,
      loading: true,
      error: null
    }))
    loadMetadata(slugLabelStore, key, () =>
      (target.kind === 'environment'
        ? callRuntimeRpc<ListLabelsBySlugResult>(
            target,
            'github.project.listLabelsBySlug',
            { owner, repo, host: githubProjectHost(host) },
            { timeoutMs: 30_000 }
          )
        : window.api.gh.listLabelsBySlug({ owner, repo, host: githubProjectHost(host) })
      ).then((res) => {
        if (!res.ok) {
          throw new Error(res.error.message)
        }
        return res.labels
      })
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
  }, [owner, repo, host, activeRuntimeEnvironmentId])

  return state
}

export function useRepoAssigneesBySlug(
  owner: string | null,
  repo: string | null,
  seedLogins?: string[],
  settings?: Pick<GlobalSettings, 'activeRuntimeEnvironmentId'> | null,
  host?: string
): MetadataState<GitHubAssignableUser[]> {
  const [state, setState] = useState<MetadataState<GitHubAssignableUser[]>>({
    data: [],
    loading: false,
    error: null
  })
  const activeKeyRef = useRef<string | null>(null)
  // Why: seedLogins is a new array reference each parent render. Stabilize on
  // the joined-string identity so the effect doesn't re-fire on every render
  // — this is the assignee popover refetch-storm fix.
  const seedKey = (seedLogins ?? []).slice().sort().join(',')
  // Why: see useRepoLabelsBySlug — primitive env id keeps failure setState from
  // re-arming the effect through a fresh settings object identity.
  const activeRuntimeEnvironmentId = settings?.activeRuntimeEnvironmentId ?? null

  useEffect(() => {
    if (!owner || !repo) {
      return
    }
    const target = getActiveRuntimeTarget({ activeRuntimeEnvironmentId })
    const repositoryKey = githubRepoIdentityKey({ owner, repo, host })
    const key =
      target.kind === 'environment'
        ? `runtime:${target.environmentId}:${repositoryKey}#${seedKey}`
        : `${repositoryKey}#${seedKey}`

    const cached = getFreshMetadata(slugAssigneeStore, key)
    if (cached) {
      // Why: see useRepoLabelsBySlug — avoid cached no-op writes when only
      // the settings object identity changed.
      if (activeKeyRef.current !== key) {
        setState({ data: cached.data, loading: false, error: null })
      }
      activeKeyRef.current = key
      return
    }

    if (activeKeyRef.current === key) {
      return
    }
    activeKeyRef.current = key
    const requestKey = key
    setState((s) => ({
      ...s,
      data: s.data.length ? ([] as typeof s.data) : s.data,
      loading: true,
      error: null
    }))
    const args = {
      owner,
      repo,
      host: githubProjectHost(host),
      ...(seedKey ? { seedLogins: seedKey.split(',') } : {})
    }
    loadMetadata(slugAssigneeStore, key, () =>
      (target.kind === 'environment'
        ? callRuntimeRpc<ListAssignableUsersBySlugResult>(
            target,
            'github.project.listAssignableUsersBySlug',
            args,
            { timeoutMs: 30_000 }
          )
        : window.api.gh.listAssignableUsersBySlug(args)
      ).then((res) => {
        if (!res.ok) {
          throw new Error(res.error.message)
        }
        return res.users
      })
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
  }, [owner, repo, host, seedKey, activeRuntimeEnvironmentId])

  return state
}
