import { useEffect, useMemo } from 'react'
import { create } from 'zustand'
import type { PluginHostListEntry } from '../../../preload/api-types'
import type { PluginStatusBarOverrides } from '../../../shared/plugins/contributions/plugin-status-bar-state'
import type { PluginDeclarativeTone } from '../../../shared/plugins/declarative/plugin-declarative-catalog'
import {
  fromPlugin,
  isLivePlugin,
  usePluginPanelsStore,
  ensurePluginPanelsLoaded,
  type ActivePluginCommand
} from './plugin-panels'

/** A status bar item of an enabled plugin, with its worker's changes applied. */
export type ActivePluginStatusBarItem = {
  key: string
  pluginName: string
  text?: string
  icon?: string
  tone: PluginDeclarativeTone
  tooltip: string
  command: ActivePluginCommand | null
}

/** Mirrors main's snapshot of `statusBar.update` changes. */
export const usePluginStatusBarStore = create<{ overrides: PluginStatusBarOverrides }>(() => ({
  overrides: {}
}))

let watching = false

function watchPluginStatusBar(): void {
  const plugins = window.api?.plugins
  if (watching || !plugins?.statusBarState || !plugins.onStatusBarChanged) {
    return
  }
  watching = true
  plugins.onStatusBarChanged((overrides) => usePluginStatusBarStore.setState({ overrides }))
  void plugins
    .statusBarState()
    .then((overrides) => usePluginStatusBarStore.setState({ overrides }))
    // Why ignored: an older host has no runtime changes; items keep their manifest values.
    .catch(() => undefined)
}

export function collectPluginStatusBarItems(
  plugins: readonly PluginHostListEntry[],
  overrides: PluginStatusBarOverrides
): ActivePluginStatusBarItem[] {
  return plugins.filter(isLivePlugin).flatMap((plugin) =>
    (plugin.statusBarItems ?? []).flatMap((declared) => {
      const item = { ...declared, ...overrides[plugin.pluginKey]?.[declared.id] }
      if (item.visible === false || (!item.text && !item.icon)) {
        return []
      }
      const command = plugin.commands.find((candidate) => candidate.id === declared.command)
      return [
        {
          key: `${plugin.pluginKey}/${declared.id}`,
          pluginName: plugin.name,
          ...(item.text ? { text: item.text } : {}),
          ...(item.icon ? { icon: item.icon } : {}),
          tone: item.tone ?? 'neutral',
          tooltip: item.tooltip || plugin.name,
          command: command ? fromPlugin(plugin, command) : null
        }
      ]
    })
  )
}

export function usePluginStatusBarItems(): ActivePluginStatusBarItem[] {
  const plugins = usePluginPanelsStore((state) => state.plugins)
  const overrides = usePluginStatusBarStore((state) => state.overrides)
  useEffect(() => {
    ensurePluginPanelsLoaded()
    watchPluginStatusBar()
  }, [])
  return useMemo(() => collectPluginStatusBarItems(plugins, overrides), [plugins, overrides])
}
