import { useEffect, useMemo } from 'react'
import { create } from 'zustand'
import type { PluginHostListEntry, PluginHostPanel } from '../../../preload/api-types'

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
    // Older paired preload may lack plugins namespace; treat missing bridge as empty content.
    const pluginsApi = window.api?.plugins
    if (!pluginsApi) {
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
  return Object.fromEntries(
    Object.entries(panelErrors).filter(([tabKey]) => installed.has(tabKey))
  ) as Record<string, true>
}

let changeSubscriptionStarted = false

/** Install startup fetch/change subscription once; safe for repeated callers. */
export function ensurePluginPanelsLoaded(): void {
  const { fetchStatus, fetchPlugins } = usePluginPanelsStore.getState()
  if (fetchStatus === 'idle') {
    void fetchPlugins()
  }
  if (!changeSubscriptionStarted && window.api?.plugins?.onChanged) {
    changeSubscriptionStarted = true
    window.api.plugins.onChanged(() => {
      void usePluginPanelsStore.getState().fetchPlugins()
    })
  }
}

/** Enabled/consented panels remain available while workers are idle/restarting; panels need no worker. */
export function collectActivePluginPanels(plugins: PluginHostListEntry[]): ActivePluginPanel[] {
  return plugins
    .filter(
      (plugin) =>
        plugin.status === 'running' || plugin.status === 'restarting' || plugin.status === 'idle'
    )
    .flatMap((plugin) =>
      plugin.panels.map((panel) => ({
        ...panel,
        pluginKey: plugin.pluginKey,
        pluginName: plugin.name
      }))
    )
}

/** Installed keys normalize persisted routes: remove uninstalled panels, retain merely disabled ones. */
export function collectInstalledPluginTabKeys(
  plugins: readonly PluginHostListEntry[]
): Set<string> {
  return new Set(plugins.flatMap((plugin) => plugin.panels.map((panel) => panel.tabKey)))
}

export function collectActivePluginCommands(
  plugins: readonly PluginHostListEntry[]
): ActivePluginCommand[] {
  return plugins
    .filter(
      (plugin) =>
        plugin.status === 'running' || plugin.status === 'restarting' || plugin.status === 'idle'
    )
    .flatMap((plugin) =>
      plugin.commands.map((command) => ({
        ...command,
        pluginKey: plugin.pluginKey,
        pluginName: plugin.name
      }))
    )
}

export function collectEditablePluginCommands(
  plugins: readonly PluginHostListEntry[]
): ActivePluginCommand[] {
  return plugins
    .filter((plugin) => ['running', 'restarting', 'idle', 'errored'].includes(plugin.status))
    .flatMap((plugin) =>
      plugin.commands.map((command) => ({
        ...command,
        pluginKey: plugin.pluginKey,
        pluginName: plugin.name
      }))
    )
}

/** Panel contributions of enabled plugins, loading the list on first use. */
export function usePluginPanels(): ActivePluginPanel[] {
  const plugins = usePluginPanelsStore((s) => s.plugins)
  useEffect(() => {
    ensurePluginPanelsLoaded()
  }, [])
  // Derive outside selector in useMemo or unstable snapshots loop through useSyncExternalStore.
  return useMemo(() => collectActivePluginPanels(plugins), [plugins])
}

/** Commands of enabled plugins, sharing the authoritative plugin-list refresh. */
export function usePluginCommands(): ActivePluginCommand[] {
  const plugins = usePluginPanelsStore((state) => state.plugins)
  useEffect(() => {
    ensurePluginPanelsLoaded()
  }, [])
  return useMemo(() => collectActivePluginCommands(plugins), [plugins])
}

/** Enabled commands remain editable while a chord conflict has errored the
 * plugin, so a saved override can recover both conflicting plugins. */
export function useEditablePluginCommands(): ActivePluginCommand[] {
  const plugins = usePluginPanelsStore((state) => state.plugins)
  useEffect(() => {
    ensurePluginPanelsLoaded()
  }, [])
  return useMemo(() => collectEditablePluginCommands(plugins), [plugins])
}
