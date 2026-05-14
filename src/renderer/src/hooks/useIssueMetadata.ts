import { useEffect, useRef, useState } from 'react'
import type {
  GitHubAssignableUser,
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

export function useRepoLabels(repoPath: string | null): MetadataState<string[]> {
  const [state, setState] = useState<MetadataState<string[]>>({
    data: [],
    loading: false,
    error: null
  })
  const activeKeyRef = useRef<string | null>(null)

  useEffect(() => {
    if (!repoPath) {
      return
    }

    const cached = getFreshMetadata(ghLabelStore, repoPath)
    if (cached) {
      if (activeKeyRef.current !== repoPath) {
        setState({ data: cached.data, loading: false, error: null })
        activeKeyRef.current = repoPath
      }
      return
    }

    activeKeyRef.current = repoPath
    const requestKey = repoPath
    setState((s) => ({
      ...s,
      data: s.data.length ? ([] as typeof s.data) : s.data,
      loading: true,
      error: null
    }))
    loadMetadata(ghLabelStore, repoPath, () =>
      window.api.gh.listLabels({ repoPath }).then((labels) => labels as string[])
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
  }, [repoPath])

  return state
}

export function useRepoAssignees(repoPath: string | null): MetadataState<GitHubAssignableUser[]> {
  const [state, setState] = useState<MetadataState<GitHubAssignableUser[]>>({
    data: [],
    loading: false,
    error: null
  })
  const activeKeyRef = useRef<string | null>(null)

  useEffect(() => {
    if (!repoPath) {
      return
    }

    const cached = getFreshMetadata(ghAssigneeStore, repoPath)
    if (cached) {
      if (activeKeyRef.current !== repoPath) {
        setState({ data: cached.data, loading: false, error: null })
        activeKeyRef.current = repoPath
      }
      return
    }

    activeKeyRef.current = repoPath
    const requestKey = repoPath
    setState((s) => ({
      ...s,
      data: s.data.length ? ([] as typeof s.data) : s.data,
      loading: true,
      error: null
    }))
    loadMetadata(ghAssigneeStore, repoPath, () =>
      window.api.gh
        .listAssignableUsers({ repoPath })
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
  }, [repoPath])

  return state
}

// ─── Linear ────────────────────────────────────────────────

const linearStateStore = createMetadataRequestStore<LinearWorkflowState[]>()
const linearLabelStore = createMetadataRequestStore<LinearLabel[]>()
const linearMemberStore = createMetadataRequestStore<LinearMember[]>()

export function clearLinearMetadataCache(): void {
  clearMetadataRequestStore(linearStateStore)
  clearMetadataRequestStore(linearLabelStore)
  clearMetadataRequestStore(linearMemberStore)
}

export function clearGitHubMetadataCache(): void {
  clearMetadataRequestStore(ghLabelStore)
  clearMetadataRequestStore(ghAssigneeStore)
}

export function useTeamStates(teamId: string | null): MetadataState<LinearWorkflowState[]> {
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

    const cached = getFreshMetadata(linearStateStore, teamId)
    if (cached) {
      if (activeKeyRef.current !== teamId) {
        setState({ data: cached.data, loading: false, error: null })
        activeKeyRef.current = teamId
      }
      return
    }

    activeKeyRef.current = teamId
    const requestKey = teamId
    setState((s) => ({
      ...s,
      data: s.data.length ? ([] as typeof s.data) : s.data,
      loading: true,
      error: null
    }))
    loadMetadata(linearStateStore, teamId, () =>
      window.api.linear.teamStates({ teamId }).then((states) => states as LinearWorkflowState[])
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
  }, [teamId])

  return state
}

export function useTeamLabels(teamId: string | null): MetadataState<LinearLabel[]> {
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

    const cached = getFreshMetadata(linearLabelStore, teamId)
    if (cached) {
      if (activeKeyRef.current !== teamId) {
        setState({ data: cached.data, loading: false, error: null })
        activeKeyRef.current = teamId
      }
      return
    }

    activeKeyRef.current = teamId
    const requestKey = teamId
    setState((s) => ({
      ...s,
      data: s.data.length ? ([] as typeof s.data) : s.data,
      loading: true,
      error: null
    }))
    loadMetadata(linearLabelStore, teamId, () =>
      window.api.linear.teamLabels({ teamId }).then((labels) => labels as LinearLabel[])
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
  }, [teamId])

  return state
}

export function useTeamMembers(teamId: string | null): MetadataState<LinearMember[]> {
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

    const cached = getFreshMetadata(linearMemberStore, teamId)
    if (cached) {
      if (activeKeyRef.current !== teamId) {
        setState({ data: cached.data, loading: false, error: null })
        activeKeyRef.current = teamId
      }
      return
    }

    activeKeyRef.current = teamId
    const requestKey = teamId
    setState((s) => ({
      ...s,
      data: s.data.length ? ([] as typeof s.data) : s.data,
      loading: true,
      error: null
    }))
    loadMetadata(linearMemberStore, teamId, () =>
      window.api.linear.teamMembers({ teamId }).then((members) => members as LinearMember[])
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
  }, [teamId])

  return state
}

export { useImmediateMutation } from './useImmediateMutation'
