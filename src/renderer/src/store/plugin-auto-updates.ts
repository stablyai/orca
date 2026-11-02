import { create } from 'zustand'
import { toast } from 'sonner'
import type { PluginAutoUpdateEvent } from '../../../preload/api-types'
import type { PluginAutoUpdateState } from '../../../shared/plugins/catalog/plugin-update-policy'
import { translate } from '@/i18n/i18n'
import { announcePluginUpdateReviews } from './plugin-update-review-toast'

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

/** Shows held updates main has not told yet; main marks them told, so each version shows once. */
async function announceUntoldUpdateReviews(): Promise<void> {
  const plugins = window.api?.plugins
  if (!plugins?.takeUpdateReviewNotices) {
    return
  }
  // Why ignored: an older host has no review notices to report.
  const notices = await plugins.takeUpdateReviewNotices().catch(() => [])
  announcePluginUpdateReviews(notices)
}

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
    void announceUntoldUpdateReviews()
  })
  void Promise.resolve()
    .then(() => plugins.getAutoUpdateState())
    .then((state) => usePluginAutoUpdatesStore.setState(state))
    // Why ignored: an older host has no automatic updates to report.
    .catch(() => undefined)
    // Why on start too: a pass may have finished while no window was open.
    .then(announceUntoldUpdateReviews)
}
