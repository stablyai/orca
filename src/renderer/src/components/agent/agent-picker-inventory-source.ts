import {
  modelCatalogSource,
  type ModelCatalogSurface,
  type ModelCatalogSource
} from '../../../../shared/agent-session/options/model-catalog-source'
import type { TuiAgent } from '../../../../shared/agent-launch/catalog/tui-agent'
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
  observeSurface?: (agent: string, surface: ModelCatalogSurface) => () => void
}

type WritableAgentPickerInventorySource = AgentPickerInventorySource &
  Pick<AgentPickerAcquisitionObserver, 'usesSource' | 'subscribeDemand'> & {
    publish: (entries: readonly AgentPickerEntry[]) => void
  }

export function createAgentPickerInventorySource(
  initial: AgentPickerEntry[]
): WritableAgentPickerInventorySource {
  let entries = initial
  const listeners = new Set<() => void>()
  const demand = new Map<string, number>()
  const demandListeners = new Set<() => void>()
  return {
    getSnapshot: () => entries,
    usesSource: (entry: AgentPickerEntry, source: ModelCatalogSource) =>
      source !== 'cli' ||
      modelCatalogSource(entry.agent, entry.defaultSurface) === source ||
      (demand.get(entry.agent) ?? 0) > 0,
    subscribeDemand: (listener: () => void) => {
      demandListeners.add(listener)
      return () => {
        demandListeners.delete(listener)
      }
    },
    observeSurface: (agent: string, surface: ModelCatalogSurface) => {
      if (modelCatalogSource(agent, surface) !== 'cli') {
        return () => {}
      }
      demand.set(agent, (demand.get(agent) ?? 0) + 1)
      demandListeners.forEach((listener) => listener())
      return () => {
        const next = (demand.get(agent) ?? 1) - 1
        if (next) {
          demand.set(agent, next)
        } else {
          demand.delete(agent)
        }
      }
    },
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
  return useAppViewExternalStore(source.subscribe, source.getSnapshot, source.getSnapshot)
}

export type AgentPickerAcquisitionObserver = {
  publish: (entries: AgentPickerEntry[]) => void
  selected: () => TuiAgent | undefined
  usesSource?: (entry: AgentPickerEntry, source: ModelCatalogSource) => boolean
  subscribeDemand?: (listener: () => void) => () => void
}
export type AgentPickerAcquisitionReads = {
  settings?: () => Promise<AgentPickerEntry[] | undefined>
  catalog: (
    entry: AgentPickerEntry,
    waitForListing: boolean,
    source?: ModelCatalogSource
  ) => Promise<AgentPickerEntry['catalog'] | undefined>
  observeCatalog?: (
    entry: AgentPickerEntry,
    publish: (snapshot: {
      answer?: AgentPickerEntry['catalog']
      pending: boolean
      invalidated?: boolean
    }) => void,
    source?: ModelCatalogSource
  ) => () => void
  support: (entry: AgentPickerEntry) => Promise<AgentPickerEntry['structured'] | undefined>
}
