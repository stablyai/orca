import { useDeferredValue, useEffect, useMemo } from 'react'
import type { Automation } from '../../../../shared/automations-types'
import { getAutomationRunRepoId } from '../../../../shared/automation-run-identity'
import type { Repo } from '../../../../shared/repo-types'
import {
  automationListSearchIndexMatches,
  buildAutomationListSearchIndex,
  buildAutomationProjectSearchText,
  resolveAutomationListSearchQuery,
  truncateAutomationListSearchField,
  AUTOMATION_LIST_SEARCH_PROMPT_MAX_CODE_UNITS,
  type AutomationListSearchFields,
  type AutomationListSearchIndex
} from './automation-list-search'
import type { ExternalAutomationListEntry } from './external-automation-list-entries'
import { getExternalProviderLabel } from './external-automation-display'

export function useAutomationListSearch({
  listSearchQuery,
  automations,
  externalAutomationEntries,
  repoMap,
  selectedId,
  selectedExternalKey,
  selectAutomationId,
  selectExternalKey
}: {
  listSearchQuery: string
  automations: readonly Automation[]
  externalAutomationEntries: readonly ExternalAutomationListEntry[]
  repoMap: ReadonlyMap<string, Repo>
  selectedId: string | null
  selectedExternalKey: string | null
  selectAutomationId: (automationId: string | null) => void
  selectExternalKey: (externalKey: string | null) => void
}): {
  isListSearchQueryTooLarge: boolean
  isListSearchActive: boolean
  filteredAutomations: readonly Automation[]
  filteredExternalAutomationEntries: readonly ExternalAutomationListEntry[]
  hasListItems: boolean
  hasFilteredListItems: boolean
} {
  // Why: keep the input snappy; matching is deferred so caret never waits on
  // index scans. Only the normalized active query can fire a search.
  const deferredListSearchQuery = useDeferredValue(listSearchQuery)
  const liveListSearchResolution = useMemo(
    () => resolveAutomationListSearchQuery(listSearchQuery),
    [listSearchQuery]
  )
  const deferredListSearchResolution = useMemo(
    () => resolveAutomationListSearchQuery(deferredListSearchQuery),
    [deferredListSearchQuery]
  )
  // Why: field feedback tracks the live value so a huge paste is labeled
  // immediately; list filtering stays on the deferred resolution.
  const isListSearchQueryTooLarge = liveListSearchResolution.status === 'too_large'
  // Why: null means search must not run (empty, whitespace, or too large).
  const activeListSearchQuery =
    deferredListSearchResolution.status === 'active' ? deferredListSearchResolution.query : null
  const isListSearchActive = activeListSearchQuery !== null

  // Why: fingerprint includes id + search fields so refresh ticks that only
  // change nextRunAt / usage do not rebuild indexes or re-run matching. Prompts
  // are truncated to the indexed prefix so each tick stays O(bound) per row.
  const automationSearchFingerprint = useMemo(
    () =>
      automations
        .map((automation) => {
          const repo = repoMap.get(getAutomationRunRepoId(automation))
          const project = buildAutomationProjectSearchText({
            displayName: repo?.displayName,
            path: repo?.path
          })
          const prompt = truncateAutomationListSearchField(
            automation.prompt,
            AUTOMATION_LIST_SEARCH_PROMPT_MAX_CODE_UNITS
          )
          return `${automation.id}\u0001${automation.name}\u0001${project}\u0001${prompt}`
        })
        .join('\u0000'),
    [automations, repoMap]
  )
  const automationSearchRows = useMemo((): {
    id: string
    index: AutomationListSearchIndex
  }[] => {
    return automations.map((automation) => {
      const repo = repoMap.get(getAutomationRunRepoId(automation))
      return {
        id: automation.id,
        index: buildAutomationListSearchIndex({
          name: automation.name,
          project: buildAutomationProjectSearchText({
            displayName: repo?.displayName,
            path: repo?.path
          }),
          prompt: automation.prompt
        })
      }
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps -- fingerprint is the rebuild gate
  }, [automationSearchFingerprint])

  const externalAutomationSearchFingerprint = useMemo(
    () =>
      externalAutomationEntries
        .map((entry) => {
          const prompt = truncateAutomationListSearchField(
            entry.job.prompt ?? entry.job.promptPreview ?? '',
            AUTOMATION_LIST_SEARCH_PROMPT_MAX_CODE_UNITS
          )
          return `${entry.key}\u0001${entry.job.name}\u0001${getExternalProviderLabel(entry.manager)}\u0001${entry.manager.targetLabel}\u0001${entry.job.workdir ?? ''}\u0001${prompt}`
        })
        .join('\u0000'),
    [externalAutomationEntries]
  )
  const externalAutomationSearchRows = useMemo((): {
    key: string
    index: AutomationListSearchIndex
  }[] => {
    return externalAutomationEntries.map((entry) => {
      const fields: AutomationListSearchFields = {
        name: entry.job.name,
        project: [
          getExternalProviderLabel(entry.manager),
          entry.manager.targetLabel,
          entry.job.workdir
        ]
          .filter(Boolean)
          .join(' '),
        prompt: entry.job.prompt ?? entry.job.promptPreview ?? ''
      }
      return { key: entry.key, index: buildAutomationListSearchIndex(fields) }
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps -- fingerprint is the rebuild gate
  }, [externalAutomationSearchFingerprint])

  // Why: matching runs only when the normalized query or search content changes —
  // never on relativeNow / nextRunAt / usage refresh alone.
  const filteredAutomationIds = useMemo((): readonly string[] | null => {
    if (activeListSearchQuery === null) {
      return null
    }
    const ids: string[] = []
    for (const row of automationSearchRows) {
      if (automationListSearchIndexMatches(row.index, activeListSearchQuery)) {
        ids.push(row.id)
      }
    }
    return ids
  }, [activeListSearchQuery, automationSearchRows])

  const filteredExternalAutomationKeys = useMemo((): readonly string[] | null => {
    if (activeListSearchQuery === null) {
      return null
    }
    const keys: string[] = []
    for (const row of externalAutomationSearchRows) {
      if (automationListSearchIndexMatches(row.index, activeListSearchQuery)) {
        keys.push(row.key)
      }
    }
    return keys
  }, [activeListSearchQuery, externalAutomationSearchRows])

  const filteredAutomations = useMemo((): readonly Automation[] => {
    if (filteredAutomationIds === null) {
      return automations
    }
    if (filteredAutomationIds.length === 0) {
      return []
    }
    const byId = new Map(automations.map((automation) => [automation.id, automation]))
    const next: Automation[] = []
    for (const id of filteredAutomationIds) {
      const automation = byId.get(id)
      if (automation) {
        next.push(automation)
      }
    }
    return next
  }, [automations, filteredAutomationIds])

  const filteredExternalAutomationEntries = useMemo((): readonly ExternalAutomationListEntry[] => {
    if (filteredExternalAutomationKeys === null) {
      return externalAutomationEntries
    }
    if (filteredExternalAutomationKeys.length === 0) {
      return []
    }
    const byKey = new Map(externalAutomationEntries.map((entry) => [entry.key, entry]))
    const next: ExternalAutomationListEntry[] = []
    for (const key of filteredExternalAutomationKeys) {
      const entry = byKey.get(key)
      if (entry) {
        next.push(entry)
      }
    }
    return next
  }, [externalAutomationEntries, filteredExternalAutomationKeys])

  const hasListItems = automations.length + externalAutomationEntries.length > 0
  const hasFilteredListItems =
    filteredAutomations.length + filteredExternalAutomationEntries.length > 0

  // Why: when search hides the current row, move selection to the first visible
  // match so list highlight and detail stay aligned. No matches → keep detail.
  useEffect(() => {
    if (activeListSearchQuery === null) {
      return
    }
    const localVisible =
      selectedExternalKey === null &&
      selectedId != null &&
      filteredAutomations.some((automation) => automation.id === selectedId)
    const externalVisible =
      selectedExternalKey != null &&
      filteredExternalAutomationEntries.some((entry) => entry.key === selectedExternalKey)
    if (localVisible || externalVisible) {
      return
    }
    const firstLocal = filteredAutomations[0]
    if (firstLocal) {
      if (selectedExternalKey !== null) {
        selectExternalKey(null)
      }
      if (selectedId !== firstLocal.id) {
        selectAutomationId(firstLocal.id)
      }
      return
    }
    const firstExternal = filteredExternalAutomationEntries[0]
    if (firstExternal && selectedExternalKey !== firstExternal.key) {
      selectExternalKey(firstExternal.key)
    }
  }, [
    activeListSearchQuery,
    filteredAutomations,
    filteredExternalAutomationEntries,
    selectAutomationId,
    selectExternalKey,
    selectedExternalKey,
    selectedId
  ])

  return {
    isListSearchQueryTooLarge,
    isListSearchActive,
    filteredAutomations,
    filteredExternalAutomationEntries,
    hasListItems,
    hasFilteredListItems
  }
}
