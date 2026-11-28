import type { Dispatch, MutableRefObject, SetStateAction } from 'react'
import type { PluginHostListEntry } from '../../../../../shared/plugins/plugin-list-entry'

type PluginListMutationDeps = {
  mountedRef: MutableRefObject<boolean>
  applyCompletedMutation: (nextPlugins: PluginHostListEntry[]) => void
  setPluginListError: (cause: unknown) => void
  setBusyPluginKeys: Dispatch<SetStateAction<Set<string>>>
  clearBusy: (pluginKey: string) => void
  loadPluginList: (request: Promise<PluginHostListEntry[]>) => Promise<PluginHostListEntry[] | null>
  setRemovePlugin: Dispatch<SetStateAction<PluginHostListEntry | null>>
}

/** The list mutations a removal and a manual refresh share: busy state around the request, and a failure shown on the list. */
export function createPluginListMutations({
  mountedRef,
  applyCompletedMutation,
  setPluginListError,
  setBusyPluginKeys,
  clearBusy,
  loadPluginList,
  setRemovePlugin
}: PluginListMutationDeps): {
  remove: (plugin: PluginHostListEntry) => Promise<void>
  refresh: () => Promise<void>
} {
  // Why one wrapper: a list mutation marks its plugin busy and shows a failure on the list.
  const mutateList = async (
    pluginKey: string,
    request: () => Promise<PluginHostListEntry[]>
  ): Promise<boolean> => {
    setBusyPluginKeys((current) => new Set(current).add(pluginKey))
    try {
      applyCompletedMutation(await request())
      return true
    } catch (cause) {
      if (mountedRef.current) {
        setPluginListError(cause)
      }
      return false
    } finally {
      clearBusy(pluginKey)
    }
  }

  const remove = async (plugin: PluginHostListEntry): Promise<void> => {
    if (
      (await mutateList(plugin.pluginKey, () =>
        plugin.isDev
          ? window.api.plugins.unloadDevFolder({ pluginKey: plugin.pluginKey })
          : window.api.plugins.remove({ pluginKey: plugin.pluginKey })
      )) &&
      mountedRef.current
    ) {
      setRemovePlugin(null)
    }
  }

  const refresh = async (): Promise<void> => {
    await loadPluginList(window.api.plugins.refresh())
  }

  return { remove, refresh }
}
