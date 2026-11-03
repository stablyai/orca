import { useEffect } from 'react'
import { create } from 'zustand'
import type {
  PluginCardFields,
  PluginCardFieldsSnapshot
} from '../../../shared/plugins/contributions/plugin-card-fields-state'

/** Mirrors main's snapshot of `cards.setFields` values. */
export const usePluginCardFieldsStore = create<{ fields: PluginCardFieldsSnapshot }>(() => ({
  fields: {}
}))

let watching = false

function watchPluginCardFields(): void {
  const plugins = window.api?.plugins
  if (watching || !plugins?.cardFields || !plugins.onCardFieldsChanged) {
    return
  }
  watching = true
  plugins.onCardFieldsChanged((fields) => usePluginCardFieldsStore.setState({ fields }))
  void plugins
    .cardFields()
    .then((fields) => usePluginCardFieldsStore.setState({ fields }))
    .catch((cause: unknown) => console.warn('[plugins] card fields unavailable:', cause))
}

const NO_FIELDS: PluginCardFields = {}

/** One workspace's fields from one plugin; subscribes only for cards whose template reads them. */
export function usePluginCardFields(
  pluginKey: string,
  workspaceId: string,
  active: boolean
): PluginCardFields {
  useEffect(() => {
    if (active) {
      watchPluginCardFields()
    }
  }, [active])
  return usePluginCardFieldsStore((s) =>
    active ? (s.fields[pluginKey]?.[workspaceId] ?? NO_FIELDS) : NO_FIELDS
  )
}
