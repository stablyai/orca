// What a group post's question to a bot on a paired computer says: a short status beside the bot's
// name, a sentence under it while no answer came, and the shortened note; desktop and phone say it here.
import type { BotGroupRemoteAsk } from './bot-group-schema'

type Translate = (key: string, fallback: string, values?: Record<string, unknown>) => string

/** A reason as a sentence, so the line under it can follow. */
function sentence(text: string): string {
  const trimmed = text.trim()
  return trimmed === '' || /[.!?…]$/.test(trimmed) ? trimmed : `${trimmed}.`
}

export function botGroupRemoteAskLines(
  ask: BotGroupRemoteAsk,
  t: Translate
): {
  /** Its answer once that computer sent one. */
  answer: string | null
  status: string
  /** The status is a problem: not sent, or delivery unknown. */
  problem: boolean
  detail: string | null
  /** Said under an answer this computer shortened. */
  shortened: string | null
} {
  const values = { bot: ask.name, computer: ask.computer }
  const answer = ask.reply?.kind === 'answer' ? ask.reply.text : null
  const status =
    answer !== null
      ? t('bots.groups.remoteReplied', 'Replied on {{computer}}', values)
      : ask.reply?.kind === 'notice'
        ? t('bots.groups.remoteNotice', "Didn't answer on {{computer}}", values)
        : ask.state === 'failed'
          ? t('bots.groups.remoteNotSent', 'Not sent to {{computer}}', values)
          : ask.state === 'unknown'
            ? t('bots.groups.remoteUnknown', 'Delivery unknown')
            : ask.stopped
              ? t('bots.groups.remoteStopped', 'Stopped here')
              : ask.state === 'sending'
                ? t('bots.groups.remoteSending', 'Asking on {{computer}}…', values)
                : t('bots.groups.remoteAsked', 'Asked on {{computer}}', values)
  const mayAnswer = t('bots.groups.remoteMayAnswer', 'May still answer on {{computer}}.', values)
  const detail =
    answer !== null || ask.reply?.kind === 'notice'
      ? null
      : ask.state === 'failed'
        ? sentence(ask.error ?? '')
        : ask.state === 'unknown'
          ? [mayAnswer, ask.error ? sentence(ask.error) : ''].join(' ').trim()
          : ask.stopped
            ? mayAnswer
            : null
  return {
    answer,
    status,
    problem: answer === null && (ask.state === 'failed' || ask.state === 'unknown'),
    detail,
    shortened:
      ask.reply?.kind === 'answer' && ask.reply.truncated
        ? t('bots.groups.remoteShortened', 'Shortened. Full answer is on {{computer}}.', values)
        : null
  }
}
