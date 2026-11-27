import { useTranslate } from '@/i18n/use-translate'
import { BOT_MAX_MEMBERS, type Bot } from '../../../../../shared/bot-types'
import type { FeishuLocalState } from '../../../../../shared/bots/feishu-local'
import { feishuMembersOf } from '../../../../../shared/bots/feishu-members'
import type { BotWhoCanAskService, BotWhoCanAskFound } from '../BotWhoCanAskList'
import { feishuCall } from './feishu-local-client'

export function useFeishuWhoCanAsk(bot: Bot, state: FeishuLocalState): BotWhoCanAskService {
  const t = useTranslate()
  const app = state.appId ?? ''
  return {
    listed: (members) => feishuMembersOf(members, app),
    stamp: { source: 'feishu-local', workspaceId: app },
    max: BOT_MAX_MEMBERS,
    search: async (query) => {
      try {
        return {
          ok: true,
          value: await feishuCall<BotWhoCanAskFound>(bot, 'members', { botId: bot.id, query })
        }
      } catch {
        return {
          ok: false,
          error: t(
            'bots.feishu.peopleError',
            'Couldn’t read Feishu group members. Check the connection and the bot’s group-member permission.'
          )
        }
      }
    },
    errorMessage: () =>
      t(
        'bots.feishu.peopleError',
        'Couldn’t read Feishu group members. Check the connection and the bot’s group-member permission.'
      ),
    searchPlaceholder: t('bots.feishu.peopleSearch', 'Search by name or Feishu ID'),
    peopleHeading: t('bots.feishu.peopleHeading', 'People in the bot’s Feishu groups'),
    noMatch: (query) => ({
      title: t('bots.feishu.peopleNoMatch', 'No matching person: {{query}}', { query }),
      detail: t(
        'bots.feishu.peopleHint',
        'Add the person and the bot to a group, then reopen this picker. Only people the bot can read are listed.'
      )
    }),
    ownerId: state.ownerId ?? null,
    ownerName: null,
    kind: 'feishu-local',
    connector: t('bots.feishu.name', 'Feishu'),
    workspace: null,
    outsiders: state.ownerId
      ? t(
          'bots.feishu.peopleOthers',
          'Only you and the people listed here can ask in Feishu private chats and group threads. Others’ messages do not start work. Each person answers their own conversation’s buttons.'
        )
      : null,
    notYet: t(
      'bots.feishu.peoplePairFirst',
      'Connect and pair this Feishu app before adding people.'
    )
  }
}
