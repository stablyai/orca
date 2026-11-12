import { useEffect, useMemo } from 'react'
import { create } from 'zustand'
import { ensurePluginAutoUpdatesWatched } from '../updates/plugin-auto-updates'
import type {
  PluginHostListEntry,
  PluginHostPanel
} from '../../../../../shared/plugins/plugin-list-entry'
import { disambiguatedPluginNames } from '../../../components/plugins/presentation/plugin-name-disambiguation'
import type { Translate } from '../../../i18n/use-translate'

/** A panel contribution from an enabled plugin, flattened for sidebar use. */
export type ActivePluginPanel = PluginHostPanel & {
  pluginKey: string
  pluginName: string
}

export type ActivePluginCommand = PluginHostListEntry['commands'][number] & {
  pluginKey: string
  pluginName: string
}

export type PluginPanelsFetchStatus = 'idle' | 'loading' | 'ready' | 'error'
export type PluginPanelHealth = 'healthy' | 'error'

type PluginPanelsState = {
  plugins: PluginHostListEntry[]
  panelErrors: Record<string, true>
  fetchStatus: PluginPanelsFetchStatus
  fetchPlugins: () => Promise<void>
  setPlugins: (plugins: PluginHostListEntry[]) => void
  setPanelHealth: (tabKey: string, health: PluginPanelHealth) => void
}

let pluginListGeneration = 0
let pluginListRetryAttempt = 0
let pluginListRetryTimer: ReturnType<typeof setTimeout> | null = null
const PLUGIN_LIST_MAX_RETRIES = 2

function clearPluginListRetryTimer(): void {
  if (pluginListRetryTimer) {
    clearTimeout(pluginListRetryTimer)
    pluginListRetryTimer = null
  }
}

function schedulePluginListRetry(generation: number): void {
  if (pluginListRetryAttempt >= PLUGIN_LIST_MAX_RETRIES) {
    pluginListRetryAttempt = 0
    return
  }
  pluginListRetryAttempt += 1
  const delayMs = 250 * 2 ** (pluginListRetryAttempt - 1)
  pluginListRetryTimer = setTimeout(() => {
    pluginListRetryTimer = null
    const state = usePluginPanelsStore.getState()
    if (generation === pluginListGeneration && state.fetchStatus === 'error') {
      void state.fetchPlugins()
    }
  }, delayMs)
}

export const usePluginPanelsStore = create<PluginPanelsState>()((set) => ({
  plugins: [],
  panelErrors: {},
  fetchStatus: 'idle',
  fetchPlugins: async () => {
    const generation = ++pluginListGeneration
    clearPluginListRetryTimer()
    // Older paired preload, or a browser client (no `list`): no plugins, so files open in Source.
    const pluginsApi = window.api?.plugins
    if (!pluginsApi?.list) {
      if (generation === pluginListGeneration) {
        pluginListRetryAttempt = 0
        set({ fetchStatus: 'ready', plugins: [], panelErrors: {} })
      }
      return
    }
    set({ fetchStatus: 'loading' })
    try {
      const plugins = await pluginsApi.list()
      if (generation === pluginListGeneration) {
        pluginListRetryAttempt = 0
        set((state) => ({
          plugins,
          fetchStatus: 'ready',
          panelErrors: retainInstalledPanelErrors(state.panelErrors, plugins)
        }))
      }
    } catch {
      if (generation === pluginListGeneration) {
        // Failed authority refresh must unmount stale panel documents; bounded retries recover startup races without endless polling.
        set({ plugins: [], panelErrors: {}, fetchStatus: 'error' })
        schedulePluginListRetry(generation)
      }
    }
  },
  setPlugins: (plugins) => {
    pluginListGeneration += 1
    pluginListRetryAttempt = 0
    clearPluginListRetryTimer()
    set((state) => ({
      plugins,
      fetchStatus: 'ready',
      panelErrors: retainInstalledPanelErrors(state.panelErrors, plugins)
    }))
  },
  setPanelHealth: (tabKey, health) => {
    set((state) => {
      // Why: sidebar badges subscribe to this map; an unchanged health must keep its identity.
      if ((health === 'error') === (state.panelErrors[tabKey] === true)) {
        return state
      }
      const panelErrors = { ...state.panelErrors }
      if (health === 'error') {
        panelErrors[tabKey] = true
      } else {
        delete panelErrors[tabKey]
      }
      return { panelErrors }
    })
  }
}))

function retainInstalledPanelErrors(
  panelErrors: Readonly<Record<string, true>>,
  plugins: readonly PluginHostListEntry[]
): Record<string, true> {
  const installed = collectInstalledPluginTabKeys(plugins)
  const kept: Record<string, true> = {}
  for (const tabKey of Object.keys(panelErrors)) {
    if (installed.has(tabKey)) {
      kept[tabKey] = true
    }
  }
  return kept
}

let changeSubscriptionStarted = false

/** Install startup fetch/change subscription once; safe for repeated callers. */
export function ensurePluginPanelsLoaded(): void {
  const { fetchStatus, fetchPlugins } = usePluginPanelsStore.getState()
  if (fetchStatus === 'idle') {
    void fetchPlugins()
  }
  ensurePluginAutoUpdatesWatched()
  if (!changeSubscriptionStarted && window.api?.plugins?.onChanged) {
    changeSubscriptionStarted = true
    window.api.plugins.onChanged(() => {
      void usePluginPanelsStore.getState().fetchPlugins()
    })
  }
}

/** Enabled and consented, whether or not a worker runs: its contributions are offered. */
export function isLivePlugin(plugin: PluginHostListEntry): boolean {
  return plugin.status === 'running' || plugin.status === 'restarting' || plugin.status === 'idle'
}

const displayNamesByList = new WeakMap<
  readonly PluginHostListEntry[],
  ReadonlyMap<string, string>
>()

/** Installed plugins' names as shown: one sharing a name, unless official, adds its publisher. */
export function installedPluginDisplayNames(
  plugins: readonly PluginHostListEntry[],
  t?: Translate
): ReadonlyMap<string, string> {
  let names = displayNamesByList.get(plugins)
  if (!names) {
    names = disambiguatedPluginNames(
      plugins.map((plugin) => ({
        key: plugin.pluginKey,
        name: plugin.name,
        publisher: plugin.publisher || null,
        official: plugin.official
      })),
      t
    )
    displayNamesByList.set(plugins, names)
  }
  return names
}

/** A contribution tagged with the plugin it came from. */
export function fromPlugin<T>(
  plugin: PluginHostListEntry,
  contribution: T,
  names?: ReadonlyMap<string, string>
): T & { pluginKey: string; pluginName: string } {
  return {
    ...contribution,
    pluginKey: plugin.pluginKey,
    pluginName: names?.get(plugin.pluginKey) ?? plugin.name
  }
}

/** A contribution keyed across plugins, with its own icon or else the plugin's. */
export function keyedPluginContribution<T extends { id: string; icon?: string }>(
  plugin: PluginHostListEntry,
  contribution: T,
  names?: ReadonlyMap<string, string>
): T & { key: string; pluginKey: string; pluginName: string; iconUrl?: string } {
  const iconUrl = contribution.icon ?? plugin.images?.icon?.url
  return {
    ...fromPlugin(plugin, contribution, names),
    key: `${plugin.pluginKey}/${contribution.id}`,
    ...(iconUrl ? { iconUrl } : {})
  }
}

/** The plugin list loaded on first use, derived once per change; `derive` must be stable. */
export function usePluginListDerived<T>(derive: (plugins: readonly PluginHostListEntry[]) => T): T {
  const plugins = usePluginPanelsStore((state) => state.plugins)
  useEffect(() => {
    ensurePluginPanelsLoaded()
  }, [])
  // Derive outside selector in useMemo or unstable snapshots loop through useSyncExternalStore.
  return useMemo(() => derive(plugins), [derive, plugins])
}

/** Panels need no worker, so they stay available while it is idle or restarting. */
export function collectActivePluginPanels(
  plugins: readonly PluginHostListEntry[]
): ActivePluginPanel[] {
  return plugins
    .filter(isLivePlugin)
    .flatMap((plugin) =>
      plugin.panels
        .filter((panel) => panel.location !== 'settings')
        .map((panel) => fromPlugin(plugin, panel, installedPluginDisplayNames(plugins)))
    )
}

export function collectPluginSettingsPanels(
  plugins: readonly PluginHostListEntry[]
): ActivePluginPanel[] {
  return plugins.flatMap((plugin) =>
    plugin.panels
      .filter((panel) => panel.location === 'settings')
      .map((panel) => fromPlugin(plugin, panel, installedPluginDisplayNames(plugins)))
  )
}

function collectActivePluginSettingsPanels(
  plugins: readonly PluginHostListEntry[]
): ActivePluginPanel[] {
  return collectPluginSettingsPanels(
    plugins.filter((plugin) => isLivePlugin(plugin) && !plugin.needsReconsent)
  )
}

/** Installed keys normalize persisted routes: remove uninstalled panels, retain merely disabled ones. */
export function collectInstalledPluginTabKeys(
  plugins: readonly PluginHostListEntry[]
): Set<string> {
  return new Set(
    plugins.flatMap((plugin) =>
      plugin.panels.filter((panel) => panel.location !== 'settings').map((panel) => panel.tabKey)
    )
  )
}

export function collectActivePluginCommands(
  plugins: readonly PluginHostListEntry[]
): ActivePluginCommand[] {
  return plugins
    .filter(isLivePlugin)
    .flatMap((plugin) =>
      plugin.commands.map((command) =>
        fromPlugin(plugin, command, installedPluginDisplayNames(plugins))
      )
    )
}

export function collectEditablePluginCommands(
  plugins: readonly PluginHostListEntry[]
): ActivePluginCommand[] {
  return plugins
    .filter((plugin) => isLivePlugin(plugin) || plugin.status === 'errored')
    .flatMap((plugin) =>
      plugin.commands.map((command) =>
        fromPlugin(plugin, command, installedPluginDisplayNames(plugins))
      )
    )
}

/** Panel contributions of enabled plugins, loading the list on first use. */
export function usePluginPanels(location: 'sidebar' | 'settings' = 'sidebar'): ActivePluginPanel[] {
  return usePluginListDerived(
    location === 'settings' ? collectActivePluginSettingsPanels : collectActivePluginPanels
  )
}

/** Commands of enabled plugins, sharing the authoritative plugin-list refresh. */
export function usePluginCommands(): ActivePluginCommand[] {
  return usePluginListDerived(collectActivePluginCommands)
}

/** Enabled commands remain editable while a chord conflict has errored the
 * plugin, so a saved override can recover both conflicting plugins. */
export function useEditablePluginCommands(): ActivePluginCommand[] {
  return usePluginListDerived(collectEditablePluginCommands)
}
