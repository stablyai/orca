import type { Translate } from '@/i18n/use-translate'
import type { GitHubWorkItem } from '../../../../../../shared/github/work-items/work-item-types'
import type { GitLabWorkItem } from '../../../../../../shared/gitlab-types'

/** A GitHub or GitLab item state in the reader's language, for hover cards and screen readers. */
export function trackerStateLabel(
  t: Translate,
  state: GitHubWorkItem['state'] | GitLabWorkItem['state']
): string {
  switch (state) {
    case 'open':
    case 'opened':
      return t('components.native-chat.trackerPeek.state.open', 'Open')
    case 'draft':
      return t('components.native-chat.trackerPeek.state.draft', 'Draft')
    case 'merged':
      return t('components.native-chat.trackerPeek.state.merged', 'Merged')
    case 'closed':
      return t('components.native-chat.trackerPeek.state.closed', 'Closed')
    case 'locked':
      return t('components.native-chat.trackerPeek.state.locked', 'Locked')
  }
}
