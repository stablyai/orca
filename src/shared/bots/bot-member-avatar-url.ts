import { botMemberSource, type BotMember } from '../bot-types'

// GitHub people are saved by numeric user id, which GitHub serves a picture for; Slack's are saved
// with the URL the cloud sent when they were added, and Linear's people have none.
export function botMemberAvatarUrl(member: BotMember): string | null {
  if (botMemberSource(member) === 'github') {
    return /^\d+$/.test(member.id) ? `https://avatars.githubusercontent.com/u/${member.id}` : null
  }
  return member.avatarUrl ?? null
}
