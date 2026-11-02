import type { PRCommentAudienceFilter } from '../../../shared/pr-comment-audience'
import { createLocalizedCatalog } from '@/i18n/localized-catalog'
import { translate } from '@/i18n/i18n'

export const getPrCommentAudienceFilters = createLocalizedCatalog(
  (): { value: PRCommentAudienceFilter; label: string }[] => [
    { value: 'all', label: translate('auto.lib.pr.comment.audience.27ce73211c', 'All') },
    { value: 'human', label: translate('auto.lib.pr.comment.audience.a7150a17bc', 'Humans') },
    { value: 'bot', label: translate('auto.lib.pr.comment.audience.64deee36a9', 'Bots') }
  ]
)

export function getPRCommentAudienceEmptyLabel(filter: PRCommentAudienceFilter): string {
  switch (filter) {
    case 'bot':
      return translate('auto.lib.pr.comment.audience.empty.bot', 'No bot comments.')
    case 'human':
      return translate('auto.lib.pr.comment.audience.empty.human', 'No human comments.')
    case 'all':
      return translate('auto.lib.pr.comment.audience.empty.all', 'No comments yet.')
  }
}
