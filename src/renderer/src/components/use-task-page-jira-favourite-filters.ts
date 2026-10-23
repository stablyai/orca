import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { ipcOrRuntimeTargetForHostId } from '@/runtime/runtime-client-target'
import {
  jiraListFavouriteFiltersForTarget,
  type JiraFavouriteFiltersResult
} from '@/runtime/runtime-jira-favourite-filters-client'
import type { JiraFavouriteFilter } from '../../../shared/jira/jira-favourite-filters'
import type { TaskPageLinearViewStateModel } from './use-task-page-linear-view-state'
import { translate } from '@/i18n/i18n'

const EMPTY_FAVOURITES: readonly JiraFavouriteFilter[] = []
type FavouriteModel = Pick<
  TaskPageLinearViewStateModel,
  | 'jiraTaskSourceContext'
  | 'jiraTaskSourceScopeKey'
  | 'accountBackedTaskSourceHostId'
  | 'taskResumeApplied'
  | 'taskSource'
  | 'selectedJiraSiteId'
  | 'jiraConnected'
>
type Lifetime = {
  enabled: boolean
  pending: boolean
  intent: number
  ownerKey: string
  siteId: string | null | undefined
  scopeKey: string
}
type Request = { lifetime: Lifetime; refresh: number }
type Snapshot = {
  request: Request
  result: JiraFavouriteFiltersResult | null
  error: string | null
}

export function useTaskPageJiraFavouriteFilters(model: FavouriteModel) {
  const ownerKey = model.jiraTaskSourceContext?.hostId ?? model.accountBackedTaskSourceHostId
  const target = useMemo(() => ipcOrRuntimeTargetForHostId(ownerKey), [ownerKey])
  const siteId = model.selectedJiraSiteId
  const enabled = Boolean(
    model.taskResumeApplied &&
    model.taskSource === 'jira' &&
    model.jiraConnected &&
    model.jiraTaskSourceContext &&
    target &&
    siteId &&
    siteId !== 'all'
  )
  const scopeKey = model.jiraTaskSourceScopeKey
  const lifetime = useMemo<Lifetime>(
    () => ({ ownerKey, siteId, scopeKey, enabled, pending: false, intent: 0 }),
    [ownerKey, siteId, scopeKey, enabled]
  )
  const lifetimeRef = useRef<Lifetime | null>(null)
  const [refresh, setRefresh] = useState(0)
  const [openedLifetime, setOpenedLifetime] = useState<Lifetime | null>(null)
  const requested = openedLifetime === lifetime
  const request = useMemo(() => ({ lifetime, refresh }), [lifetime, refresh])
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null)
  const [selection, setSelection] = useState<{
    lifetime: Lifetime
    filter: JiraFavouriteFilter
  } | null>(null)
  const [pendingLifetime, setPendingLifetime] = useState<Lifetime | null>(null)
  const [applyError, setApplyError] = useState<{ lifetime: Lifetime; message: string } | null>(null)
  useLayoutEffect(() => {
    lifetimeRef.current = lifetime
    return () => {
      if (lifetimeRef.current === lifetime) {
        lifetimeRef.current = null
      }
    }
  }, [lifetime])
  useEffect(() => {
    if (!enabled || !requested || !target || !siteId) {
      return
    }
    let cancelled = false
    void jiraListFavouriteFiltersForTarget(target, siteId).then(
      (result) => {
        if (!cancelled) {
          setSnapshot({ request, result, error: null })
        }
      },
      (reason: unknown) => {
        if (!cancelled) {
          setSnapshot({
            request,
            result: null,
            error:
              reason instanceof Error
                ? reason.message
                : translate('jira.favourites.loadFailed', 'Could not load Jira favourites.')
          })
        }
      }
    )
    return () => {
      cancelled = true
    }
  }, [enabled, requested, request, target, siteId])
  const current = enabled && snapshot?.request === request ? snapshot : null
  const result = current?.result
  const filters = result?.supported ? result.filters : EMPTY_FAVOURITES
  const clearJiraFavouriteFilter = useCallback(() => {
    const active = lifetimeRef.current
    if (active) {
      active.intent += 1
    }
    setSelection(null)
    setApplyError(null)
  }, [])
  const applyJiraFavouriteFilter = async (
    filter: JiraFavouriteFilter,
    clearSavedSelection: () => Promise<boolean>,
    onApplied: () => void
  ): Promise<boolean> => {
    if (
      !enabled ||
      lifetimeRef.current !== lifetime ||
      lifetime.pending ||
      !filters.includes(filter)
    ) {
      return false
    }
    lifetime.pending = true
    const intent = ++lifetime.intent
    setPendingLifetime(lifetime)
    setApplyError(null)
    try {
      if (!(await clearSavedSelection())) {
        if (lifetimeRef.current === lifetime && lifetime.intent === intent) {
          setApplyError({
            lifetime,
            message: translate(
              'jira.favourites.clearFailed',
              'Could not clear the saved filter. Retry after it finishes loading or saving.'
            )
          })
        }
        return false
      }
      if (lifetimeRef.current !== lifetime || lifetime.intent !== intent) {
        return false
      }
      onApplied()
      setSelection({ lifetime, filter })
      return true
    } catch (reason) {
      if (lifetimeRef.current === lifetime && lifetime.intent === intent) {
        setApplyError({
          lifetime,
          message:
            reason instanceof Error
              ? reason.message
              : translate('jira.favourites.applyFailed', 'Could not apply the Jira favourite.')
        })
      }
      return false
    } finally {
      lifetime.pending = false
      if (lifetimeRef.current === lifetime) {
        setPendingLifetime(null)
      }
    }
  }
  return {
    jiraFavouriteFiltersEnabled: enabled,
    jiraFavouriteFilters: filters,
    jiraFavouriteFilter: enabled && selection?.lifetime === lifetime ? selection.filter : null,
    jiraFavouriteFiltersLoading: enabled && requested && current === null,
    jiraFavouriteFiltersUnsupported: result?.supported === false,
    jiraFavouriteFiltersTruncated: result?.supported ? result.truncated : false,
    jiraFavouriteFiltersPending: pendingLifetime === lifetime,
    jiraFavouriteFiltersError:
      applyError?.lifetime === lifetime ? applyError.message : (current?.error ?? null),
    loadJiraFavouriteFilters: () => setOpenedLifetime(lifetime),
    retryJiraFavouriteFilters: () => {
      setOpenedLifetime(lifetime)
      setRefresh((value) => value + 1)
    },
    clearJiraFavouriteFilter,
    applyJiraFavouriteFilter
  }
}
