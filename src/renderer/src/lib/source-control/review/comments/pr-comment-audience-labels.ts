import type { PRCommentAudienceFilter } from '../../../../../../shared/source-control/review-comments/pr-comment-audience'
import { createLocalizedCatalog } from '@/i18n/localized-catalog'
import { translate } from '@/i18n/i18n'
import type { Translate } from '@/i18n/use-translate'

export const getPrCommentAudienceFilters = createLocalizedCatalog(
  (): { value: PRCommentAudienceFilter; label: string }[] => [
    { value: 'all', label: translate('auto.lib.pr.comment.audience.27ce73211c', 'All') },
    { value: 'human', label: translate('auto.lib.pr.comment.audience.a7150a17bc', 'Humans') },
    { value: 'bot', label: translate('auto.lib.pr.comment.audience.64deee36a9', 'Bots') }
  ]
)

export function getPRCommentAudienceEmptyLabel(
  filter: PRCommentAudienceFilter,
  t: Translate = translate
): string {
  switch (filter) {
    case 'bot':
      return t('auto.lib.pr.comment.audience.empty.bot', 'No bot comments.')
    case 'human':
      return t('auto.lib.pr.comment.audience.empty.human', 'No human comments.')
    case 'all':
      return t('auto.lib.pr.comment.audience.empty.all', 'No comments yet.')
  }
}
