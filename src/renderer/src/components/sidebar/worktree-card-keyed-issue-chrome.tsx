import { JiraIcon } from '@/components/icons/JiraIcon'
import { YouTrackIcon } from '@/components/icons/YouTrackIcon'
import { translate } from '@/i18n/i18n'
import type { WorktreeCardJiraIssueDisplay } from './worktree-card-meta-types'

type KeyedIssueChrome = {
  Icon: (props: { className?: string }) => React.JSX.Element
  title: (identifier: string) => string
  linkedLabel: (identifier: string) => string
  viewLabel: () => string
}

/** Icon and labels for the string-keyed issue row, which Jira and YouTrack share. */
const KEYED_ISSUE_CHROME: Record<'jira' | 'youtrack', KeyedIssueChrome> = {
  jira: {
    Icon: JiraIcon,
    title: (identifier) =>
      translate('auto.components.sidebar.WorktreeCardMeta.jiraIssue', 'Jira {{value0}}', {
        value0: identifier
      }),
    linkedLabel: (identifier) =>
      translate('auto.components.sidebar.WorktreeCardMeta.linkedJira', 'Linked Jira {{value0}}', {
        value0: identifier
      }),
    viewLabel: () =>
      translate('auto.components.sidebar.WorktreeCardMeta.viewOnJira', 'View on Jira')
  },
  youtrack: {
    Icon: YouTrackIcon,
    title: (identifier) =>
      translate('youtrack.sidebar.issue', 'YouTrack {{value0}}', { value0: identifier }),
    linkedLabel: (identifier) =>
      translate('youtrack.sidebar.linkedIssue', 'Linked YouTrack {{value0}}', {
        value0: identifier
      }),
    viewLabel: () => translate('youtrack.sidebar.viewIssue', 'View in YouTrack')
  }
}

export function getKeyedIssueChrome(issue: WorktreeCardJiraIssueDisplay): KeyedIssueChrome {
  return KEYED_ISSUE_CHROME[issue.provider ?? 'jira']
}

export function KeyedIssueIcon({
  issue,
  className
}: {
  issue: WorktreeCardJiraIssueDisplay
  className?: string
}): React.JSX.Element {
  const { Icon } = getKeyedIssueChrome(issue)
  return <Icon className={className} />
}
