import { create } from 'zustand'
import { toast } from 'sonner'
import type { PluginAutoUpdateEvent } from '../../../preload/api-types'
import type { PluginAutoUpdateState } from '../../../shared/plugins/catalog/plugin-update-policy'
import { translate } from '@/i18n/i18n'

/** What automatic plugin updates last did, mirrored from main. */
export const usePluginAutoUpdatesStore = create<PluginAutoUpdateState>(() => ({
  updated: {},
  needsReview: {}
}))

/** At most one toast per pass, however many plugins it updated. */
export function announcePluginAutoUpdates(updated: PluginAutoUpdateEvent['updated']): void {
  if (updated.length === 0) {
    return
  }
  toast.success(
    updated.length === 1
      ? translate('auto.store.pluginAutoUpdates.one', '{{value0}} updated to {{value1}}', {
          value0: updated[0].name,
          value1: updated[0].version
        })
      : translate('auto.store.pluginAutoUpdates.many', '{{value0}} plugins updated', {
          value0: updated.length
        })
  )
}

let watching = false

/** Starts mirroring automatic update results; safe to call repeatedly. */
export function ensurePluginAutoUpdatesWatched(): void {
  const plugins = window.api?.plugins
  if (watching || !plugins?.onAutoUpdateChanged) {
    return
  }
  watching = true
  plugins.onAutoUpdateChanged((event) => {
    usePluginAutoUpdatesStore.setState(event.state)
    announcePluginAutoUpdates(event.updated)
  })
  void Promise.resolve()
    .then(() => plugins.getAutoUpdateState())
    .then((state) => usePluginAutoUpdatesStore.setState(state))
    // Why ignored: an older host has no automatic updates to report.
    .catch(() => undefined)
}
