import { useCallback, useMemo, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import type { BusinessmapCard } from '../../../shared/businessmap-types'
import type { TaskSourceContext } from '../../../shared/task-source-context'
import { useAppStore } from '@/store'
import { findTaskPageBusinessmapCard } from '@/components/task-page-businessmap-cache-selectors'

export function useTaskPageBusinessmapDetailRouting(
  businessmapTaskSourceContext: TaskSourceContext | null | undefined
) {
  const [selectedBusinessmapCardId, setSelectedBusinessmapCardId] = useState<number | null>(null)
  const [selectedBusinessmapCardFallback, setSelectedBusinessmapCardFallback] =
    useState<BusinessmapCard | null>(null)
  const businessmapCacheSnapshot = useAppStore(
    useShallow((s) => ({
      cardCache: s.businessmapCardCache,
      searchCache: s.businessmapSearchCache
    }))
  )
  const cachedSelectedBusinessmapCard = findTaskPageBusinessmapCard(
    businessmapCacheSnapshot.cardCache,
    businessmapCacheSnapshot.searchCache,
    selectedBusinessmapCardId,
    { sourceContext: businessmapTaskSourceContext }
  )
  const selectedBusinessmapCard = selectedBusinessmapCardId
    ? (cachedSelectedBusinessmapCard ?? selectedBusinessmapCardFallback)
    : null
  const businessmapDetailSourceContext = useMemo(
    () => businessmapTaskSourceContext,
    [businessmapTaskSourceContext]
  )
  const setSelectedBusinessmapCard = useCallback((card: BusinessmapCard | null) => {
    setSelectedBusinessmapCardId(card?.id ?? null)
    setSelectedBusinessmapCardFallback(card)
  }, [])
  const clearSelectedBusinessmapCard = useCallback(() => {
    setSelectedBusinessmapCardId(null)
    setSelectedBusinessmapCardFallback(null)
  }, [])
  const openBusinessmapCardDetailPage = useCallback(
    (card: BusinessmapCard) => {
      setSelectedBusinessmapCard(card)
    },
    [setSelectedBusinessmapCard]
  )
  return {
    selectedBusinessmapCardId,
    setSelectedBusinessmapCardId,
    selectedBusinessmapCardFallback,
    setSelectedBusinessmapCardFallback,
    businessmapCacheSnapshot,
    cachedSelectedBusinessmapCard,
    selectedBusinessmapCard,
    businessmapDetailSourceContext,
    setSelectedBusinessmapCard,
    clearSelectedBusinessmapCard,
    openBusinessmapCardDetailPage
  }
}
