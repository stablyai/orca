import { create } from 'zustand'
import type { PluginUpdateReviewNotice } from '../../../../../shared/plugins/catalog/plugin-update-policy'

const noticeId = (notice: PluginUpdateReviewNotice): string =>
  `${notice.pluginKey}@${notice.version}`

/** Held updates the toast shows; PluginUpdateReviewHost renders them. */
export const usePluginUpdateReviewNoticesStore = create<{
  notices: readonly PluginUpdateReviewNotice[]
}>(() => ({ notices: [] }))

/**
 * Adds held updates main just reported. A later batch joins the open toast instead of hiding an
 * earlier one; a newer version of a plugin replaces its older notice.
 */
export function announcePluginUpdateReviews(fresh: readonly PluginUpdateReviewNotice[]): void {
  if (fresh.length === 0) {
    return
  }
  const freshKeys = new Set(fresh.map((notice) => notice.pluginKey))
  usePluginUpdateReviewNoticesStore.setState(({ notices }) => ({
    notices: [...notices.filter((notice) => !freshKeys.has(notice.pluginKey)), ...fresh]
  }))
}

/** Drops exactly the notices handled; one that arrived meanwhile, even a newer version, stays. */
export function resolvePluginUpdateReviews(handled: readonly PluginUpdateReviewNotice[]): void {
  const done = new Set(handled.map(noticeId))
  usePluginUpdateReviewNoticesStore.setState(({ notices }) => ({
    notices: notices.filter((notice) => !done.has(noticeId(notice)))
  }))
}

/** The toast's identity: a new set of versions remounts it so it reloads what it shows. */
export const pluginUpdateReviewNoticesKey = (
  notices: readonly PluginUpdateReviewNotice[]
): string => notices.map(noticeId).join(',')
