import { botMemberSource, type BotMember } from '../bot-types'

export const feishuMembersOf = (members: readonly BotMember[], appId: string): BotMember[] =>
  members.filter(
    (m) => botMemberSource(m) === 'feishu-local' && m.workspaceId === appId && m.kind !== 'app'
  )

export function feishuAsker(
  binding: { app: string; owner: string | null },
  members: readonly BotMember[],
  sender: string | null
): { userId: string; role: 'owner' | 'member'; name?: string } | null {
  if (!binding.owner || !sender) {
    return null
  }
  if (sender === binding.owner) {
    return { userId: sender, role: 'owner' }
  }
  const member = feishuMembersOf(members, binding.app).find((m) => m.id === sender)
  return member
    ? { userId: sender, role: 'member', ...(member.name ? { name: member.name } : {}) }
    : null
}
