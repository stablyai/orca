// A bot's Slack people follow its Slack workspaces: a removed workspace takes its people with it.
import {
  botMemberSource,
  botSlackApps,
  withSlackMembersTagged,
  type Bot,
  type BotMember
} from '../bot-types'

/** The updated bot's people, less any Slack person of a workspace it is no longer in. Untagged
 *  people are the first workspace's as it was before this update. */
export function membersInSlackWorkspaces(
  before: Pick<Bot, 'slack' | 'slackApps'>,
  next: Pick<Bot, 'slack' | 'slackApps' | 'members'>
): BotMember[] {
  const first = botSlackApps(before)[0] ?? botSlackApps(next)[0]
  const teams = new Set(botSlackApps(next).map((app) => app.teamId))
  const tagged = withSlackMembersTagged({
    members: next.members,
    slack: null,
    slackApps: first ? [first] : []
  }).members
  return tagged.filter(
    (member) =>
      botMemberSource(member) !== 'slack' ||
      member.workspaceId === undefined ||
      teams.has(member.workspaceId)
  )
}
