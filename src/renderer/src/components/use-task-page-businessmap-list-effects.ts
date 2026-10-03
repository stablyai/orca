import type { TaskPageJiraListEffectsModel } from './use-task-page-jira-list-effects'
import { useEffect } from 'react'
import { createTaskPageBusinessmapLoadFailureState } from '@/components/task-page-businessmap-load-state'
import { BUSINESSMAP_ITEM_LIMIT, TASK_SEARCH_DEBOUNCE_MS } from './task-page-source-context'

export function useTaskPageBusinessmapListEffects(model: TaskPageJiraListEffectsModel) {
  const {
    setTaskResumeState,
    searchBusinessmapCards,
    listBusinessmapCards,
    businessmapConnected,
    taskSource,
    businessmapTaskSourceContext,
    businessmapSearchPersistReadyRef,
    taskResumeApplied,
    businessmapSearchInput,
    appliedBusinessmapSearch,
    setAppliedBusinessmapSearch,
    activeBusinessmapPreset,
    businessmapRefreshNonce,
    setBusinessmapCards,
    setBusinessmapLoading,
    setBusinessmapError,
    setBusinessmapErrorDetailsOpen,
    selectedBusinessmapCardId,
    setSelectedBusinessmapCardId,
    setSelectedBusinessmapCardFallback,
    displayedBusinessmapCards
  } = model
  useEffect(() => {
    if (!taskResumeApplied) {
      return
    }
    const timeout = window.setTimeout(() => {
      setAppliedBusinessmapSearch(businessmapSearchInput)
    }, TASK_SEARCH_DEBOUNCE_MS)
    return () => window.clearTimeout(timeout)
  }, [businessmapSearchInput, taskResumeApplied, setAppliedBusinessmapSearch])
  useEffect(() => {
    if (!taskResumeApplied) {
      return
    }
    if (!businessmapSearchPersistReadyRef.current) {
      businessmapSearchPersistReadyRef.current = true
      return
    }
    setTaskResumeState({
      businessmapQuery: appliedBusinessmapSearch.trim()
    })
  }, [
    appliedBusinessmapSearch,
    setTaskResumeState,
    taskResumeApplied,
    businessmapSearchPersistReadyRef
  ])
  useEffect(() => {
    if (!taskResumeApplied) {
      return
    }
    if (taskSource !== 'businessmap') {
      return
    }
    if (!businessmapConnected) {
      return
    }
    let cancelled = false
    setBusinessmapLoading(true)
    setBusinessmapError(null)
    setBusinessmapErrorDetailsOpen(false)
    const trimmed = appliedBusinessmapSearch.trim()
    const request =
      trimmed.length > 0
        ? searchBusinessmapCards(trimmed, BUSINESSMAP_ITEM_LIMIT, {
            sourceContext: businessmapTaskSourceContext
          })
        : listBusinessmapCards(activeBusinessmapPreset, BUSINESSMAP_ITEM_LIMIT, {
            sourceContext: businessmapTaskSourceContext
          })
    void request
      .then((cards) => {
        if (cancelled) {
          return
        }
        setBusinessmapCards(cards)
        setBusinessmapLoading(false)
      })
      .catch((err) => {
        if (cancelled) {
          return
        }
        const failureState = createTaskPageBusinessmapLoadFailureState(err)
        setBusinessmapCards(failureState.cards)
        setBusinessmapError(failureState.error)
        setBusinessmapLoading(false)
      })
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    taskSource,
    businessmapConnected,
    appliedBusinessmapSearch,
    activeBusinessmapPreset,
    businessmapRefreshNonce,
    taskResumeApplied,
    businessmapTaskSourceContext
  ])
  useEffect(() => {
    if (!taskResumeApplied || taskSource !== 'businessmap') {
      return
    }
    if (!businessmapConnected || displayedBusinessmapCards.length === 0) {
      if (selectedBusinessmapCardId !== null) {
        setSelectedBusinessmapCardId(null)
      }
      setSelectedBusinessmapCardFallback(null)
      return
    }
    if (
      selectedBusinessmapCardId !== null &&
      !displayedBusinessmapCards.some((card) => card.id === selectedBusinessmapCardId)
    ) {
      setSelectedBusinessmapCardId(null)
      setSelectedBusinessmapCardFallback(null)
    }
  }, [
    displayedBusinessmapCards,
    businessmapConnected,
    selectedBusinessmapCardId,
    taskResumeApplied,
    taskSource,
    setSelectedBusinessmapCardFallback,
    setSelectedBusinessmapCardId
  ])
  return model
}

export type TaskPageBusinessmapListEffectsModel = ReturnType<
  typeof useTaskPageBusinessmapListEffects
>
