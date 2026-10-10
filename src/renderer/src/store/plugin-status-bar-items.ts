import { useEffect, useMemo } from 'react'
import { create } from 'zustand'
import type { PluginStatusBarItemSnapshot } from '../../../shared/plugins/plugin-status-bar'

type PluginStatusBarItemsState = {
  items: PluginStatusBarItemSnapshot[]
}

export const usePluginStatusBarItemsStore = create<PluginStatusBarItemsState>()(() => ({
  items: []
}))

let subscriptionStarted = false

/** Loads plugin status-bar items and follows main's pushes; safe to call
 *  repeatedly. Listing is also main's activation trigger for the workers that
 *  fill the items, so it re-runs whenever the installed plugin set changes. */
export function ensurePluginStatusBarItemsLoaded(): void {
  const pluginsApi = window.api?.plugins
  // Why: a preload that predates plugin status-bar items simply shows none.
  if (subscriptionStarted || !pluginsApi?.listStatusBarItems) {
    return
  }
  subscriptionStarted = true
  const setItems = (items: PluginStatusBarItemSnapshot[]): void =>
    usePluginStatusBarItemsStore.setState({ items })
  const list = (): void => {
    void pluginsApi.listStatusBarItems().then(setItems, () => undefined)
  }
  pluginsApi.onStatusBarItemsChanged?.(setItems)
  pluginsApi.onChanged?.(list)
  list()
}

/** Plugin status-bar items for one side of the bar, in render order. */
export function usePluginStatusBarItems(
  alignment: PluginStatusBarItemSnapshot['alignment']
): PluginStatusBarItemSnapshot[] {
  const items = usePluginStatusBarItemsStore((state) => state.items)
  useEffect(() => {
    ensurePluginStatusBarItemsLoaded()
  }, [])
  return useMemo(() => items.filter((item) => item.alignment === alignment), [alignment, items])
}
