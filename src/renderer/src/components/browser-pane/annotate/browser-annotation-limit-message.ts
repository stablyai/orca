import { translate } from '@/i18n/i18n'
import type { Translate } from '@/i18n/use-translate'
import { GRAB_BUDGET } from '../../../../../shared/browser/element-grab/browser-grab-types'

export const browserAnnotationLimitMessage = (t: Translate = translate): string =>
  t(
    'auto.components.browser.pane.annotate.use.browser.page.grab.annotations.limitReached',
    'Limit of {{limit}} annotations reached. Send, delete or clear some to add more.',
    { limit: GRAB_BUDGET.annotationsMaxPerPage }
  )
