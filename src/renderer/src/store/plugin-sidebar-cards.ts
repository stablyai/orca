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

/** The plugin card the person picked, or null for Orca's own card. Every card shares one
 *  registration object, so this stays referentially stable across unrelated store writes. */
export function useSelectedPluginCard(): PluginSidebarCardRegistration | null {
  const cardId = useAppStore((s) => {
    const id = s.settings?.workspaceCardId
    return id && !isPluginContentSwitchedOff(s.settings ?? undefined, id) ? id : null
  })
  useEffect(() => {
    if (cardId) {
      sidebarCards.ensureLoaded()
    }
  }, [cardId])
  return usePluginSidebarCardStore((s) =>
    cardId ? (s.entries.find((entry) => entry.id === cardId) ?? null) : null
  )
}

/** The picked card's template, for callers that only draw it. */
export function useSelectedPluginCardTemplate(): CardTemplate | null {
  return useSelectedPluginCard()?.template ?? null
}
