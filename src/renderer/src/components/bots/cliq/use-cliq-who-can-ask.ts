import { useMemo } from 'react'
import { useTranslate } from '@/i18n/use-translate'
import { useBotHostLabel } from '../use-bot-host-label'
import { botCliqCalls } from '@/lib/bot-connector-host-calls'
import type { Bot, BotCliqBot } from '../../../../../shared/bot-types'
import { cliqMembersOf } from '../../../../../shared/bots/bot-cliq-members'
import { CONNECTOR_CLIENT_LIMITS } from '../../../../../shared/connectors/connector-cloud-contract'
import type { BotWhoCanAskService } from '../BotWhoCanAskList'
import { botCliqErrorMessage } from './bot-cliq-copy'
import type { CliqSignIn } from './cliq-setup-step'

/** A bot's Cliq row › People with access: the people in its Cliq organization the owner lets ask.
 *  Searching them needs the owner's Zoho sign-in there (`signIn`). */
export function useCliqWhoCanAsk(
  bot: Pick<Bot, 'id' | 'hostId'>,
  cliq: BotCliqBot,
  signIn: CliqSignIn | null
): BotWhoCanAskService {
  const t = useTranslate()
  const hostName = useBotHostLabel(bot.hostId)
  const { orgId } = cliq
  const org = cliq.orgName || signIn?.name || orgId
  const ownerId = signIn?.userId ?? null
  const ownerName = signIn ? signIn.userName || signIn.userId : null
  const searchable = signIn !== null && !signIn.expired
  return useMemo(
    (): BotWhoCanAskService => ({
      listed: (members) => cliqMembersOf(members, orgId),
      stamp: { source: 'cliq', workspaceId: orgId },
      max: CONNECTOR_CLIENT_LIMITS.maxBotWorkspaceMembers,
      search: (query) => botCliqCalls(bot.hostId).members({ botId: bot.id, orgId, query }),
      errorMessage: (code) => botCliqErrorMessage(code, hostName),
      searchPlaceholder: t('bots.whoCanAsk.searchIn', 'Search people in {{workspace}}', {
        workspace: org
      }),
      peopleHeading: t('bots.whoCanAsk.peopleIn', 'People in {{workspace}}', { workspace: org }),
      noMatch: (query) => ({
        title: t('bots.whoCanAsk.noOneNamed', 'No one named “{{query}}” in {{workspace}}', {
          query,
          workspace: org
        }),
        detail: t(
          'bots.cliq.whoCanAsk.noMatchDetail',
          'Active users of {{org}}’s Cliq can be added. The bot doesn’t answer anyone else.',
          { org }
        )
      }),
      ownerId,
      ownerName,
      kind: 'cliq',
      connector: 'Zoho Cliq',
      workspace: org,
      outsiders: searchable
        ? t('bots.cliq.whoCanAsk.outsiders', 'Everyone else in {{org}} is ignored.', { org })
        : null,
      notYet: t(
        'bots.cliq.whoCanAsk.needsSetup',
        'Finish setup to sign in to Zoho in {{org}}, then pick people here.',
        { org }
      )
    }),
    [bot.hostId, bot.id, hostName, orgId, org, searchable, ownerId, ownerName, t]
  )
}
