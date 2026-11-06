import { translate } from '@/i18n/i18n'
import { GRAB_BUDGET } from '../../../../../shared/browser-grab-types'

export const browserAnnotationLimitMessage = (): string =>
  translate(
    'auto.components.browser.pane.annotate.use.browser.page.grab.annotations.limitReached',
    'Limit of {{limit}} annotations reached. Send, delete or clear some to add more.',
    { limit: GRAB_BUDGET.annotationsMaxPerPage }
  )
