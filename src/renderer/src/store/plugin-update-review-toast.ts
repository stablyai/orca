// @protected-copy
import { toast } from 'sonner'
import type { PluginUpdateReviewNotice } from '../../../shared/plugins/catalog/plugin-update-policy'
import { translate } from '@/i18n/i18n'
import { requestPluginUpdateReview } from './plugin-preview-request'

// Why settings.Plugin keys: that namespace is protected, so a language pack cannot soften the warning.
function singleTitle(notice: PluginUpdateReviewNotice): string {
  const values = { value0: notice.name, value1: notice.version }
  return notice.reason === 'repository'
    ? translate(
        'auto.components.settings.PluginUpdateReviewToast.movedTitle',
        '{{value0}} {{value1}} comes from a different repository',
        values
      )
    : translate(
        'auto.components.settings.PluginUpdateReviewToast.accessTitle',
        '{{value0}} {{value1}} wants more access',
        values
      )
}

// What the open toast covers, so a later batch joins it instead of hiding an earlier one.
let showing: PluginUpdateReviewNotice[] = []

/**
 * Tells the user that automatic updates are waiting on them: one toast, however many.
 * Review only opens the existing review; approving stays in that dialog.
 */
export function announcePluginUpdateReviews(fresh: readonly PluginUpdateReviewNotice[]): void {
  if (fresh.length === 0) {
    return
  }
  const freshKeys = new Set(fresh.map((notice) => notice.pluginKey))
  showing = [...showing.filter((notice) => !freshKeys.has(notice.pluginKey)), ...fresh]
  const notices = showing
  const [only] = notices
  if (!only) {
    return
  }
  const single = notices.length === 1
  const close = (): void => {
    showing = []
  }
  toast.warning(
    single
      ? singleTitle(only)
      : translate(
          'auto.components.settings.PluginUpdateReviewToast.manyTitle',
          '{{value0}} plugin updates need your review',
          { value0: notices.length }
        ),
    {
      id: 'plugin-update-review',
      duration: Infinity,
      onDismiss: close,
      description: single
        ? translate(
            'auto.components.settings.PluginUpdateReviewToast.oneDescription',
            'Published by {{value0}}. It won’t update until you review it.',
            { value0: only.publisher }
          )
        : translate(
            'auto.components.settings.PluginUpdateReviewToast.manyDescription',
            'They won’t update until you review them.'
          ),
      action: {
        label: translate('auto.components.settings.PluginUpdateReviewToast.review', 'Review'),
        onClick: () => {
          close()
          requestPluginUpdateReview({ pluginKey: single ? only.pluginKey : null })
        }
      },
      cancel: {
        label: translate('auto.components.settings.PluginUpdateReviewToast.dismiss', 'Dismiss'),
        onClick: close
      }
    }
  )
}
