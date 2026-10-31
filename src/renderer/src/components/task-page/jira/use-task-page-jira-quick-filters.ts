import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { ipcOrRuntimeTargetForHostId } from '@/runtime/runtime-client-target'
import {
  readJiraQuickFilterState,
  writeJiraQuickFilterState
} from '@/runtime/runtime-jira-quick-filter-state'
import {
  normalizeJiraQuickFilterState,
  type JiraQuickFilterState
} from '../../../../../shared/jira/jira-quick-filters'
import type { TaskPageLinearViewStateModel } from '../linear/use-task-page-linear-view-state'
import { translate } from '@/i18n/i18n'

const EMPTY_QUICK_FILTER_STATE: JiraQuickFilterState = { statuses: [] }
type JiraQuickFilterModel = Pick<
  TaskPageLinearViewStateModel,
  'jiraTaskSourceContext' | 'accountBackedTaskSourceHostId' | 'taskResumeApplied' | 'taskSource'
>

export function useTaskPageJiraQuickFilters(model: JiraQuickFilterModel) {
  const ownerKey = model.jiraTaskSourceContext?.hostId ?? model.accountBackedTaskSourceHostId
  const target = useMemo(() => ipcOrRuntimeTargetForHostId(ownerKey), [ownerKey])
  const [snapshot, setSnapshot] = useState({
    ownerKey: '',
    state: normalizeJiraQuickFilterState(undefined)
  })
  const [loading, setLoading] = useState(true)
  const lifetime = useMemo(() => ({ ownerKey }), [ownerKey])
  const [pendingLifetime, setPendingLifetime] = useState<typeof lifetime | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [refresh, setRefresh] = useState(0)
  const lifetimeRef = useRef<typeof lifetime | null>(null)
  const writePendingRef = useRef<typeof lifetime | null>(null)
  useLayoutEffect(() => {
    lifetimeRef.current = lifetime
    return () => {
      lifetimeRef.current = null
    }
  }, [lifetime])
  const ready = target !== null && snapshot.ownerKey === ownerKey
  const state = ready ? snapshot.state : EMPTY_QUICK_FILTER_STATE
  useEffect(() => {
    if (!model.taskResumeApplied || model.taskSource !== 'jira') {
      return
    }
    let cancelled = false
    setLoading(true)
    setError(null)
    const load = async () => {
      try {
        if (!target) {
          return
        }
        const next = await readJiraQuickFilterState(target)
        if (!cancelled) {
          setSnapshot({ ownerKey, state: next })
        }
      } catch (reason) {
        if (!cancelled) {
          setError(
            reason instanceof Error
              ? reason.message
              : translate('jira.statusFilters.loadFailed', 'Could not load Jira status filters.')
          )
        }
      } finally {
        if (!cancelled) {
          setLoading(false)
        }
      }
    }
    void load()
    return () => {
      cancelled = true
    }
  }, [ownerKey, target, model.taskResumeApplied, model.taskSource, refresh])

  const select = async (statuses: string[]): Promise<void> => {
    if (
      !ready ||
      loading ||
      writePendingRef.current === lifetime ||
      !target ||
      lifetimeRef.current !== lifetime
    ) {
      return
    }
    const expectedOwner = ownerKey
    const stillCurrent = () => lifetimeRef.current === lifetime
    writePendingRef.current = lifetime
    setPendingLifetime(lifetime)
    setError(null)
    try {
      const next = await writeJiraQuickFilterState(target, { statuses })
      if (stillCurrent()) {
        setSnapshot({ ownerKey: expectedOwner, state: next })
      }
    } catch (reason) {
      if (stillCurrent()) {
        setError(
          reason instanceof Error
            ? reason.message
            : translate('jira.statusFilters.saveFailed', 'Could not save Jira status filters.')
        )
      }
      throw reason
    } finally {
      if (stillCurrent()) {
        writePendingRef.current = null
        setPendingLifetime(null)
      }
    }
  }
  return {
    selectedJiraStatuses: state.statuses,
    jiraQuickFiltersReady: ready,
    jiraQuickFiltersLoading: loading,
    jiraQuickFiltersPending: pendingLifetime === lifetime,
    jiraQuickFiltersError: error,
    retryJiraQuickFilters: () => setRefresh((value) => value + 1),
    selectJiraStatuses: select
  }
}
