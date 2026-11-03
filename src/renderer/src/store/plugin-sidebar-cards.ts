import {
  isPluginSidebarCardRegistration,
  type PluginSidebarCardRegistration
} from '../../../shared/plugins/artifacts/plugin-sidebar-card-artifact'
import { isPluginContentSwitchedOff } from '../../../shared/plugins/plugin-system-settings'
import type { CardTemplate } from '../../../shared/workspace-cards/card-template-schema'
import { useEffect } from 'react'
import { createPluginContentListStore } from './plugin-content-list-store'
import { useAppStore } from './index'

const sidebarCards = createPluginContentListStore<PluginSidebarCardRegistration>({
  kind: 'sidebar cards',
  list: (api) => api.listSidebarCards,
  isEntry: isPluginSidebarCardRegistration
})

export const usePluginSidebarCardStore = sidebarCards.useStore
export const usePluginSidebarCards = sidebarCards.useEntries

export type SelectedPluginCard = {
  entry: PluginSidebarCardRegistration
  template: CardTemplate
  /** Declared option defaults overlaid with the person's values. */
  options: Readonly<Record<string, string | number | boolean>>
}

const NO_VALUES: Readonly<Record<string, string | number | boolean>> = {}

export function resolvePluginCardOptions(
  entry: PluginSidebarCardRegistration,
  values: Readonly<Record<string, string | number | boolean>> | undefined
): SelectedPluginCard['options'] {
  const resolved: Record<string, string | number | boolean> = {}
  for (const option of entry.options ?? []) {
    const value = values && Object.hasOwn(values, option.key) ? values[option.key] : option.default
    if (value !== undefined) {
      resolved[option.key] = value
    }
  }
  return resolved
}

/** The plugin card the person picked, or null for Orca's own card. Every card shares one result,
 *  so it stays referentially stable across unrelated store writes. */
export function useSelectedPluginCard(): SelectedPluginCard | null {
  const cardId = useAppStore((s) => {
    const id = s.settings?.workspaceCardId
    return id && !isPluginContentSwitchedOff(s.settings ?? undefined, id) ? id : null
  })
  const values = useAppStore((s) =>
    cardId ? (s.settings?.workspaceCardOptions?.[cardId] ?? NO_VALUES) : NO_VALUES
  )
  useEffect(() => {
    if (cardId) {
      sidebarCards.ensureLoaded()
    }
  }, [cardId])
  const entry = usePluginSidebarCardStore((s) =>
    cardId ? (s.entries.find((candidate) => candidate.id === cardId) ?? null) : null
  )
  return selectedCard(entry, values)
}

const selectedCards = new WeakMap<object, WeakMap<object, SelectedPluginCard>>()

// Why a shared cache: 300 cards share one result instead of building their own.
function selectedCard(
  entry: PluginSidebarCardRegistration | null,
  values: Readonly<Record<string, string | number | boolean>>
): SelectedPluginCard | null {
  if (!entry) {
    return null
  }
  let byValues = selectedCards.get(entry)
  if (!byValues) {
    byValues = new WeakMap()
    selectedCards.set(entry, byValues)
  }
  let selected = byValues.get(values)
  if (!selected) {
    selected = { entry, template: entry.template, options: resolvePluginCardOptions(entry, values) }
    byValues.set(values, selected)
  }
  return selected
}

export function ensurePluginSidebarCardsLoaded(): void {
  sidebarCards.ensureLoaded()
}

/** The picked card's template, for callers that only draw it. */
export function useSelectedPluginCardTemplate(): CardTemplate | null {
  return useSelectedPluginCard()?.template ?? null
}
