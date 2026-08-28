import type { GitHubAssignableUser } from '../../../../../shared/github/pull-request-types'
import type { PRComment } from '../../../../../shared/github/comment-types'
import type { GitHubWorkItem } from '../../../../../shared/github/work-item-types'
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

  add(item.author, item.type === 'pr' ? 'PR author' : 'Issue author')
  for (const comment of comments) {
    add(comment.author, 'Commenter', comment.authorAvatarUrl)
  }
  for (const user of participants) {
    add(user.login, 'Participant', user.avatarUrl, user.name)
  }
  for (const user of assignableUsers) {
    add(user.login, 'Team member', user.avatarUrl, user.name)
  }

  return Array.from(byLogin.values())
}
