import { useMemo } from 'react'
import { useTranslate } from '@/i18n/use-translate'
import { useBotHostLabel } from '../use-bot-host-label'
import { slackTeamState, useBotSlack } from '@/lib/bot-slack-state'
import { botSlackCalls } from '@/lib/bot-connector-host-calls'
import {
  BOT_MAX_MEMBERS,
  botMembersFrom,
  slackMembersOf,
  type Bot,
  type BotMember
} from '../../../../../shared/bot-types'
import type { BotWhoCanAskService } from '../BotWhoCanAskList'
import { botSlackErrorMessage } from './bot-slack-copy'

/**
 * A bot's Slack row › People with access: the Slack members the owner lets ask the bot in one
 * workspace. No team: every Slack person, for a row left after its app was removed.
 */
export function useSlackWhoCanAsk(bot: Bot, rowTeamId?: string): BotWhoCanAskService {
  const t = useTranslate()
  const hostName = useBotHostLabel(bot.hostId)
  const slack = useBotSlack(bot)
  const team = slack.status === 'ready' ? slackTeamState(slack.slack, rowTeamId) : null
  const installed = team?.state === 'installed' ? team : null
  const workspace = installed ? (installed.teamName ?? installed.teamId) : null
  const teamId = installed?.teamId ?? null
  const ownerId = installed?.installerUserId ?? null
  const ownerName = installed?.installerName ?? null
  const place = workspace ?? 'Slack'
  const { slack: first, slackApps } = bot
  return useMemo(
    (): BotWhoCanAskService => ({
      listed: (members: readonly BotMember[]) =>
        rowTeamId === undefined
          ? botMembersFrom(members, 'slack')
          : slackMembersOf({ members, slack: first, slackApps }, rowTeamId),
      stamp:
        rowTeamId === undefined ? { source: 'slack' } : { source: 'slack', workspaceId: rowTeamId },
      max: BOT_MAX_MEMBERS,
      search: (query) =>
        botSlackCalls(bot.hostId).members({
          botId: bot.id,
          query,
          teamId: rowTeamId
        }),
      errorMessage: (code) => botSlackErrorMessage(code, hostName),
      searchPlaceholder: t('bots.whoCanAsk.searchIn', 'Search people in {{workspace}}', {
        workspace: place
      }),
      peopleHeading: t('bots.whoCanAsk.peopleIn', 'People in {{workspace}}', {
        workspace: place
      }),
      noMatch: (query) => ({
        title: t('bots.whoCanAsk.noOneNamed', 'No one named “{{query}}” in {{workspace}}', {
          query,
          workspace: place
        }),
        detail: t(
          'bots.whoCanAsk.noMatchDetail',
          'Members, guests and people from other organizations in {{workspace}}’s Slack can be added. Anyone else gets a private note to ask you.',
          { workspace: place }
        )
      }),
      ownerId,
      ownerName,
      kind: 'slack',
      connector: 'Slack',
      workspace,
      outsiders:
        workspace === null
          ? null
          : t(
              'bots.whoCanAsk.outsiders',
              'Everyone else in {{workspace}} gets a private note to ask you.',
              { workspace }
            ),
      notYet: t(
        'bots.whoCanAsk.needsSlack',
        'Add {{name}} to Slack first to pick people from your workspace.',
        { name: bot.name }
      ),
      accessRequests: teamId === null ? null : { source: 'slack', workspaceId: teamId }
    }),
    [
      bot.id,
      bot.hostId,
      hostName,
      bot.name,
      workspace,
      place,
      teamId,
      ownerId,
      ownerName,
      rowTeamId,
      first,
      slackApps,
      t
    ]
  )
}
