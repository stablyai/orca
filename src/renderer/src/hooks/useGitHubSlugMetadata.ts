// Why: when the dialog opens for a Project row whose repo differs from the
// active workspace, label/assignee lookups must target the row's repo via
// slug-addressed IPCs (`listLabelsBySlug` / `listAssignableUsersBySlug`),
// not via the workspace path. These hooks live in their own module so the
// existing repoPath-keyed hooks stay focused on the local-workspace flow
// and so this file remains under the lint line cap.
import { useEffect, useRef, useState } from 'react'
import type { GitHubAssignableUser } from '../../../shared/types'
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

const slugLabelStore = createMetadataRequestStore<string[]>()
const slugAssigneeStore = createMetadataRequestStore<GitHubAssignableUser[]>()

export function clearGitHubSlugMetadataCache(): void {
  clearMetadataRequestStore(slugLabelStore)
  clearMetadataRequestStore(slugAssigneeStore)
}

export function useRepoLabelsBySlug(
  owner: string | null,
  repo: string | null
): MetadataState<string[]> {
  const [state, setState] = useState<MetadataState<string[]>>({
    data: [],
    loading: false,
    error: null
  })
  const activeKeyRef = useRef<string | null>(null)

  useEffect(() => {
    if (!owner || !repo) {
      return
    }
    const key = `${owner}/${repo}`

    const cached = getFreshMetadata(slugLabelStore, key)
    if (cached) {
      // Why: always seed state from cache. A remount with the same key
      // resets local state to defaults but `activeKeyRef.current` from the
      // new ref instance is null on first run — the previous gate that
      // skipped setState when keys matched dropped cached data on remount.
      setState({ data: cached.data, loading: false, error: null })
      activeKeyRef.current = key
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
      window.api.gh.listLabelsBySlug({ owner, repo }).then((res) => {
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
  }, [owner, repo])

  return state
}

export function useRepoAssigneesBySlug(
  owner: string | null,
  repo: string | null,
  seedLogins?: string[]
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

  useEffect(() => {
    if (!owner || !repo) {
      return
    }
    const key = `${owner}/${repo}#${seedKey}`

    const cached = getFreshMetadata(slugAssigneeStore, key)
    if (cached) {
      // Why: see useRepoLabelsBySlug — always seed state from cache so a
      // remount with the same key picks up cached data instead of staying
      // at the empty default.
      setState({ data: cached.data, loading: false, error: null })
      activeKeyRef.current = key
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
    loadMetadata(slugAssigneeStore, key, () =>
      window.api.gh
        .listAssignableUsersBySlug({
          owner,
          repo,
          ...(seedKey ? { seedLogins: seedKey.split(',') } : {})
        })
        .then((res) => {
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
  }, [owner, repo, seedKey])

  return state
}
