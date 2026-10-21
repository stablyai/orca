import { createNonSecureContextUuid } from '../../../shared/non-secure-context-uuid'
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { ipcOrRuntimeTargetForHostId } from '@/runtime/runtime-client-target'
import {
  mutateJiraSavedFilters,
  readJiraSavedFilterState
} from '@/runtime/runtime-jira-saved-filter-state'
import type {
  JiraSavedFilterMutation,
  JiraSavedFilter,
  JiraSavedFilterState
} from '../../../shared/jira-saved-filters'
import type { TaskPageLinearViewStateModel } from './use-task-page-linear-view-state'
import { translate } from '@/i18n/i18n'

const EMPTY_SAVED_FILTER_STATE: JiraSavedFilterState = { filters: [], activeFilterId: null }

type JiraSavedFilterModel = Pick<
  TaskPageLinearViewStateModel,
  'jiraTaskSourceContext' | 'accountBackedTaskSourceHostId' | 'taskResumeApplied' | 'taskSource'
>

type JiraSavedFilterOwner = { ownerKey: string; enabled: boolean }
type JiraSavedFilterLifetime = {
  owner: JiraSavedFilterOwner
  pending: boolean
  reading: boolean
  state: JiraSavedFilterState | null
}

export function useTaskPageJiraSavedFilters(
  model: JiraSavedFilterModel,
  setQuery: (jql: string) => void
) {
  const ownerKey = model.jiraTaskSourceContext?.hostId ?? model.accountBackedTaskSourceHostId
  const target = useMemo(() => ipcOrRuntimeTargetForHostId(ownerKey), [ownerKey])
  const [snapshot, setSnapshot] = useState<{
    owner: JiraSavedFilterOwner | null
    state: JiraSavedFilterState
  }>({
    owner: null,
    state: EMPTY_SAVED_FILTER_STATE
  })
  const [loading, setLoading] = useState(true)
  const [pendingLifetime, setPendingLifetime] = useState<JiraSavedFilterLifetime | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [refresh, setRefresh] = useState(0)
  const loadedOwnerRef = useRef<string | null>(null)
  const enabled = model.taskResumeApplied && model.taskSource === 'jira'
  const owner = useMemo(() => ({ ownerKey, enabled }), [ownerKey, enabled])
  const lifetimeRef = useRef<JiraSavedFilterLifetime | null>(null)
  const pending = pendingLifetime?.owner === owner
  useLayoutEffect(() => {
    if (!owner.enabled) {
      return
    }
    const lifetime: JiraSavedFilterLifetime = { owner, pending: false, reading: true, state: null }
    lifetimeRef.current = lifetime
    return () => {
      if (lifetimeRef.current === lifetime) {
        lifetimeRef.current = null
      }
    }
  }, [owner])
  const state = snapshot.owner === owner ? snapshot.state : EMPTY_SAVED_FILTER_STATE
  const ready = target !== null && snapshot.owner === owner
  useEffect(() => {
    const lifetime = lifetimeRef.current
    if (!lifetime || lifetime.owner !== owner) {
      return
    }
    let cancelled = false
    lifetime.reading = true
    if (loadedOwnerRef.current !== null && loadedOwnerRef.current !== ownerKey) {
      setQuery('')
    }
    setLoading(true)
    setError(null)
    const load = async (): Promise<void> => {
      try {
        if (!target) {
          return
        }
        const next = await readJiraSavedFilterState(target)
        if (cancelled || lifetimeRef.current !== lifetime) {
          return
        }
        lifetime.state = next
        setSnapshot({ owner, state: next })
        const active = next.filters.find((filter) => filter.id === next.activeFilterId)
        if (active) {
          setQuery(active.jql)
        } else if (loadedOwnerRef.current !== null && loadedOwnerRef.current !== ownerKey) {
          setQuery('')
        }
        loadedOwnerRef.current = ownerKey
      } catch (reason) {
        if (!cancelled && lifetimeRef.current === lifetime) {
          setError(
            reason instanceof Error
              ? reason.message
              : translate('jira.savedFilters.loadFailed', 'Could not load saved Jira filters.')
          )
        }
      } finally {
        if (!cancelled && lifetimeRef.current === lifetime) {
          lifetime.reading = false
          setLoading(false)
        }
      }
    }
    void load()
    return () => {
      cancelled = true
    }
  }, [owner, ownerKey, target, refresh, setQuery])

  const mutate = async (mutation: JiraSavedFilterMutation): Promise<boolean> => {
    const lifetime = lifetimeRef.current
    if (
      !ready ||
      !target ||
      !lifetime ||
      lifetime.owner !== owner ||
      !lifetime.state ||
      lifetime.pending ||
      lifetime.reading
    ) {
      return false
    }
    lifetime.pending = true
    setPendingLifetime(lifetime)
    setError(null)
    try {
      const next = await mutateJiraSavedFilters(target, mutation)
      if (lifetimeRef.current !== lifetime) {
        return false
      }
      lifetime.state = next
      setSnapshot({ owner, state: next })
      if (mutation.kind === 'select') {
        const active = next.filters.find(
          (filter) => filter.id === mutation.id && filter.id === next.activeFilterId
        )
        if (active) {
          setQuery(active.jql)
        } else if (mutation.id !== null || next.activeFilterId !== null) {
          return false
        }
      } else if (mutation.kind === 'save' && next.activeFilterId === mutation.filter.id) {
        setQuery(mutation.filter.jql)
      } else if (mutation.kind === 'delete' && state.activeFilterId === mutation.id) {
        setQuery('')
      }
      return true
    } catch (reason) {
      if (lifetimeRef.current === lifetime) {
        setError(
          reason instanceof Error
            ? reason.message
            : translate('jira.savedFilters.saveFailed', 'Could not save Jira filters.')
        )
      }
      throw reason
    } finally {
      lifetime.pending = false
      if (lifetimeRef.current === lifetime) {
        setPendingLifetime(null)
      }
    }
  }
  return {
    jiraSavedFilters: state.filters,
    jiraActiveSavedFilterId: state.activeFilterId,
    jiraSavedFiltersReady: ready,
    jiraSavedFiltersLoading: loading,
    jiraSavedFiltersPending: pending,
    jiraSavedFiltersError: error,
    retryJiraSavedFilters: () => {
      if (lifetimeRef.current?.pending) {
        return
      }
      if (lifetimeRef.current) {
        lifetimeRef.current.reading = true
      }
      setRefresh((value) => value + 1)
    },
    applyJiraSavedFilter: (filter: JiraSavedFilter) => mutate({ kind: 'select', id: filter.id }),
    createJiraSavedFilter: async (filter: { name: string; jql: string }) => {
      await mutate({ kind: 'save', filter: { ...filter, id: createNonSecureContextUuid() } })
    },
    updateJiraSavedFilter: async (id: string, filter: { name: string; jql: string }) => {
      await mutate({ kind: 'save', filter: { ...filter, id } })
    },
    deleteJiraSavedFilter: async (id: string) => {
      await mutate({ kind: 'delete', id })
    },
    clearJiraSavedFilterSelection: async (): Promise<boolean> => {
      const lifetime = lifetimeRef.current
      if (
        !ready ||
        !target ||
        !lifetime ||
        lifetime.owner !== owner ||
        !lifetime.state ||
        lifetime.pending ||
        lifetime.reading
      ) {
        return false
      }
      if (lifetime.state?.activeFilterId) {
        return mutate({ kind: 'select', id: null })
      }
      return true
    }
  }
}
