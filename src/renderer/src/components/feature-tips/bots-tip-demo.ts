// The story's sample bot and its one item that asks you, shaped as the app's records so the card can
// draw them with the app's own item components.
import type { Translate } from '@/i18n/use-translate'
import type { Bot } from '../../../../shared/bot-types'
import type { BotItem, BotItemEvent } from '../../../../shared/bots/bot-items'

const AT = Date.parse('2026-11-19T15:41:00')
const ANSWERED_AT = AT + 60_000

export function botsTipDemo(t: Translate) {
  const bot: Bot = {
    id: 'bots-tip-release-bot',
    name: t('featureTips.botsTeammate.releaseBot', 'Release bot'),
    hostId: 'local',
    folder: 'release-bot',
    folderWorkspaceId: 'bots-tip',
    agent: 'claude',
    avatar: 'mascot:A1',
    paused: false,
    notifications: { needsPermission: true, taskComplete: true, couldNotFinish: true },
    members: [],
    slack: null,
    linear: null,
    github: null,
    chatSessionId: null,
    createdAt: AT,
    updatedAt: AT
  }
  const question = t(
    'featureTips.botsTeammate.question',
    'Sign everyone out once, or keep current sessions?'
  )
  const answer = t('featureTips.botsTeammate.answer', 'Keep current sessions.')
  const item: BotItem = {
    uid: 'safari',
    number: 42,
    owner: { botId: bot.id, name: bot.name },
    title: t('featureTips.botsTeammate.itemSafari', 'Fix the Safari login bug'),
    description: null,
    doneMeans: null,
    status: 'needs_you',
    chat: { id: 'home', kind: 'home', title: null },
    madeBy: null,
    question: { eventId: 'question', text: question },
    closeNote: null,
    wait: null,
    links: [],
    version: 1,
    lastEventId: 'question',
    othersLastEventId: 'question',
    snoozedUntil: null,
    lastActivityAt: AT,
    createdAt: AT,
    updatedAt: AT,
    closedAt: null
  }
  const questionEvent: BotItemEvent = {
    id: 'question',
    kind: 'commented',
    actor: { kind: 'bot', botId: bot.id, chatId: 'home' },
    data: { text: question },
    at: AT
  }
  const answerEvent: BotItemEvent = {
    id: 'answer',
    kind: 'commented',
    actor: { kind: 'owner' },
    data: { text: answer },
    at: ANSWERED_AT
  }
  return {
    bot,
    item,
    question,
    answer,
    openQuestion: { event: questionEvent, question: 'open' as const },
    answeredQuestion: {
      event: questionEvent,
      question: 'answered' as const,
      answer: { eventId: answerEvent.id, at: ANSWERED_AT }
    },
    ownerAnswer: {
      event: answerEvent,
      question: null,
      replyTo: { eventId: questionEvent.id, text: question }
    }
  }
}
