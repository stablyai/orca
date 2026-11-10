import { usePluginPanelsStore } from '@/store/plugins/catalog/plugin-contribution-catalog'
import type { PluginHostListEntry } from '../../../../shared/plugins/plugin-list-entry'

// Why errored too: an approved guard whose worker crashed may deny on error; main decides.
const HOOKING_STATUSES: ReadonlySet<PluginHostListEntry['status']> = new Set([
  'running',
  'restarting',
  'idle',
  'errored'
])

/** Synchronous, so an editor action with no plugin listing the hook takes no extra await. */
export function pluginEditorHookWanted(hook: string): boolean {
  return usePluginPanelsStore
    .getState()
    .plugins.some((plugin) => HOOKING_STATUSES.has(plugin.status) && plugin.hooks?.includes(hook))
}
