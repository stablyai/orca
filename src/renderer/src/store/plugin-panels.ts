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
    // Why: preload may predate the plugins namespace (web client pairing an
    // older desktop build); treat a missing bridge as "no plugins" fail-soft.
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
        // A failed authority refresh must not leave previously enabled panel
        // documents mounted from stale state. Bounded retries recover from a
        // transient preload/main startup race without spinning indefinitely.
        set({ plugins: [], panelErrors: {}, fetchStatus: 'error' })
        schedulePluginListRetry(generation)
      }
    }
  },
  setPlugins: (plugins) => {
    pluginListGeneration += 1
    pluginListRetryAttempt = 0
    if (pluginListRetryTimer) {
      clearTimeout(pluginListRetryTimer)
      pluginListRetryTimer = null
    }
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

/** Kicks off the startup fetch and subscribes to main-process change pushes
 *  (install/remove/enable/dev-reload); safe to call repeatedly. */
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

/** Panels of plugins the user enabled (consented + not disabled). `idle` and
 *  `restarting` still show panels — the panel itself never needs a worker. */
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

/** Tab keys of every installed plugin panel (any status) — used by the
 *  persisted-route normalizer to drop keys of uninstalled plugins while
 *  keeping keys that are merely disabled. */
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
  // Why: derive in useMemo (not the selector) so the store snapshot stays
  // referentially stable and doesn't retrigger useSyncExternalStore loops.
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
