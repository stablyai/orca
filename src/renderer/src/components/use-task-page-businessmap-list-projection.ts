import type { TaskPageJiraListProjectionModel } from './use-task-page-jira-list-projection'
import { useMemo } from 'react'
import { findTaskPageBusinessmapCard } from '@/components/task-page-businessmap-cache-selectors'
import { sortBusinessmapCards } from '@/components/task-page-businessmap-card-sort'

export function useTaskPageBusinessmapListProjection(model: TaskPageJiraListProjectionModel) {
  const {
    businessmapTaskSourceContext,
    businessmapCacheSnapshot,
    businessmapCards,
    businessmapOrderBy,
    businessmapOrderDirection
  } = model
  const displayedBusinessmapCards = useMemo(
    () =>
      businessmapCards.map(
        (card) =>
          findTaskPageBusinessmapCard(
            businessmapCacheSnapshot.cardCache,
            businessmapCacheSnapshot.searchCache,
            card.id,
            { sourceContext: businessmapTaskSourceContext }
          ) ?? card
      ),
    [
      businessmapCards,
      businessmapCacheSnapshot.cardCache,
      businessmapCacheSnapshot.searchCache,
      businessmapTaskSourceContext
    ]
  )
  const sortedBusinessmapCards = useMemo(
    () =>
      sortBusinessmapCards(
        displayedBusinessmapCards,
        businessmapOrderBy,
        businessmapOrderDirection
      ),
    [displayedBusinessmapCards, businessmapOrderBy, businessmapOrderDirection]
  )
  const nextModel = model as typeof model & {
    displayedBusinessmapCards: typeof displayedBusinessmapCards
    sortedBusinessmapCards: typeof sortedBusinessmapCards
  }
  nextModel.displayedBusinessmapCards = displayedBusinessmapCards
  nextModel.sortedBusinessmapCards = sortedBusinessmapCards
  return nextModel
}

export type TaskPageBusinessmapListProjectionModel = ReturnType<
  typeof useTaskPageBusinessmapListProjection
>
