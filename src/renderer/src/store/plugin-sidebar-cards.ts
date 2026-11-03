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

/** The plugin card template the person picked, or null for Orca's own card. Cards share one
 *  template object, so this stays referentially stable across unrelated store writes. */
export function useSelectedPluginCardTemplate(): CardTemplate | null {
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
    cardId ? (s.entries.find((entry) => entry.id === cardId)?.template ?? null) : null
  )
}
