import type { PluginsApi } from '../../../../preload/api/plugin-host-api'

/** Desktop-only: plugins run in the desktop app, so a web client has no updates or counts to show.
 *  Explicit because the fallback resolves `undefined`, which crashes callers expecting lists. */
export function createWebPluginsApi(): Pick<
  PluginsApi,
  'getAutoUpdateState' | 'takeUpdateReviewNotices' | 'getInstallCounts'
> {
  return {
    getAutoUpdateState: () => Promise.resolve({ updated: {}, needsReview: {} }),
    // Why empty: taking marks the host's notices told, which would hide them from its desktop app.
    takeUpdateReviewNotices: () => Promise.resolve([]),
    getInstallCounts: () => Promise.resolve({})
  }
}
