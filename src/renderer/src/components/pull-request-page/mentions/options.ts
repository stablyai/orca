import type { GitHubAssignableUser } from '../../../../../shared/github/pull-request-types'
import type { PRComment } from '../../../../../shared/github/comment-types'
import type { GitHubWorkItem } from '../../../../../shared/github/work-item-types'
import { translate } from '@/i18n/i18n'
import type { MentionOption } from '../page-types'

export function buildMentionOptions({
  item,
  comments,
  participants,
  assignableUsers
}: {
  item: GitHubWorkItem
  comments: PRComment[]
  participants: GitHubAssignableUser[]
  assignableUsers: GitHubAssignableUser[]
}): MentionOption[] {
  const byLogin = new Map<string, MentionOption>()
  const add = (
    login: string | null | undefined,
    source: string,
    avatarUrl?: string,
    name?: string | null
  ): void => {
    if (!login || login === 'ghost') {
      return
    }
    const key = login.toLowerCase()
    const existing = byLogin.get(key)
    if (existing) {
      if (!existing.avatarUrl && avatarUrl) {
        existing.avatarUrl = avatarUrl
      }
      if (!existing.name && name) {
        existing.name = name
      }
      return
    }
    byLogin.set(key, { login, source, avatarUrl, name })
  }

  add(
    item.author,
    item.type === 'pr'
      ? translate('auto.components.PullRequestPage.mentionSource.prAuthor', 'PR author')
      : translate('auto.components.PullRequestPage.mentionSource.issueAuthor', 'Issue author')
  )
  const commenter = translate(
    'auto.components.PullRequestPage.mentionSource.commenter',
    'Commenter'
  )
  for (const comment of comments) {
    add(comment.author, commenter, comment.authorAvatarUrl)
  }
  const participant = translate(
    'auto.components.PullRequestPage.mentionSource.participant',
    'Participant'
  )
  for (const user of participants) {
    add(user.login, participant, user.avatarUrl, user.name)
  }
  const teamMember = translate(
    'auto.components.PullRequestPage.mentionSource.teamMember',
    'Team member'
  )
  for (const user of assignableUsers) {
    add(user.login, teamMember, user.avatarUrl, user.name)
  }

  return Array.from(byLogin.values())
}
