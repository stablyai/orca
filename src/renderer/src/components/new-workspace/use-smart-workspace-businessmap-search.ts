import { useEffect } from 'react'
import { RESULT_LIMIT } from './smart-workspace-name-field-model'
import type { useSmartWorkspaceNameFieldFoundation } from './use-smart-workspace-name-field-foundation'

type Foundation = ReturnType<typeof useSmartWorkspaceNameFieldFoundation>

export function useSmartWorkspaceBusinessmapSearch({
  foundation,
  shouldQueryBusinessmap,
  businessmapQuery
}: {
  foundation: Foundation
  shouldQueryBusinessmap: boolean
  businessmapQuery: string
}): void {
  const {
    businessmapConnectionStatus,
    searchBusinessmapCards,
    businessmapSourceContext,
    setBusinessmapCards,
    setBusinessmapLoading
  } = foundation
  useEffect(() => {
    if (!shouldQueryBusinessmap || !businessmapSourceContext) {
      setBusinessmapCards([])
      setBusinessmapLoading(false)
      return
    }
    let stale = false
    const controller = new AbortController()
    setBusinessmapLoading(true)
    // Why: site/board scope mirrors the jira siteId scoping so multi-site accounts stay isolated.
    void searchBusinessmapCards(businessmapQuery.trim(), RESULT_LIMIT, {
      sourceContext: businessmapSourceContext,
      boardId:
        businessmapSourceContext.providerIdentity?.provider === 'businessmap'
          ? (businessmapSourceContext.providerIdentity.boardId ?? null)
          : null,
      signal: controller.signal
    })
      .then((cards) => {
        if (!stale) {
          setBusinessmapCards(cards)
        }
      })
      .catch(() => {
        if (!stale) {
          setBusinessmapCards([])
        }
      })
      .finally(() => {
        if (!stale) {
          setBusinessmapLoading(false)
        }
      })
    return () => {
      stale = true
      controller.abort()
    }
  }, [
    businessmapConnectionStatus,
    businessmapQuery,
    businessmapSourceContext,
    searchBusinessmapCards,
    setBusinessmapCards,
    setBusinessmapLoading,
    shouldQueryBusinessmap
  ])
}
