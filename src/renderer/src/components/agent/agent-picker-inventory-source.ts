import type { TuiAgent } from '../../../../shared/agent-launch/catalog/tui-agent'
import { useMemo } from 'react'
import { useUiLanguageRevision } from '@/i18n/use-ui-language-revision'
import { getAgentLabels } from '@/lib/agent-catalog/agent-catalog'
import { recomputeOn } from '@/lib/recompute-on'
import { useAppViewExternalStore } from '@/store/retained-views/app-state-view'
import type { AgentPickerEntry } from '../../../../shared/agent-launch/picker/agent-launch-picker'

/**
 * Live picker entries for one (inventory key, open) generation. Catalog and seed reads land one
 * at a time for several seconds after the menu opens; holding them here instead of in the
 * owner's React state lets only the components that render entries re-render as they land.
 */
export type AgentPickerInventorySource = {
  getSnapshot: () => AgentPickerEntry[]
  subscribe: (listener: () => void) => () => void
}

type WritableAgentPickerInventorySource = AgentPickerInventorySource & {
  publish: (entries: readonly AgentPickerEntry[]) => void
}

export function createAgentPickerInventorySource(
  initial: AgentPickerEntry[]
): WritableAgentPickerInventorySource {
  let entries = initial
  const listeners = new Set<() => void>()
  return {
    getSnapshot: () => entries,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    publish: (next) => {
      // Why: a read that changed nothing (e.g. an unavailable catalog) must not re-render the menu.
      if (next.length === entries.length && next.every((entry, i) => entry === entries[i])) {
        return
      }
      entries = [...next]
      for (const listener of listeners) {
        listener()
      }
    }
  }
}

export function useAgentPickerInventoryEntries(
  source: AgentPickerInventorySource
): AgentPickerEntry[] {
  const entries = useAppViewExternalStore(source.subscribe, source.getSnapshot, source.getSnapshot)
  // A language change updates the picker without replacing its host inventory or active drafts.
  const labels = recomputeOn([useUiLanguageRevision()], getAgentLabels)
  return useMemo(
    () =>
      entries.map((entry) => {
        const label = labels.get(entry.agent)
        return label && label !== entry.label ? { ...entry, label } : entry
      }),
    [entries, labels]
  )
}

export type AgentPickerAcquisitionObserver = {
  publish: (entries: AgentPickerEntry[]) => void
  selected: () => TuiAgent | undefined
}
export type AgentPickerAcquisitionReads = {
  settings?: () => Promise<AgentPickerEntry[] | undefined>
  catalog: (
    entry: AgentPickerEntry,
    waitForListing: boolean,
    signal: AbortSignal,
    /** The host lists this agent's models again before answering. */
    relist?: boolean
  ) => Promise<AgentPickerEntry['catalog'] | undefined>
  refreshOnInvalidation?: (entry: AgentPickerEntry) => boolean
  subscribeInvalidation?: (listener: () => void) => () => void
  support: (entry: AgentPickerEntry) => Promise<AgentPickerEntry['structured'] | undefined>
}
