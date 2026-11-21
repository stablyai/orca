import { LoaderCircle } from 'lucide-react'
import { useTranslate } from '@/i18n/use-translate'
import { useUiLanguageRevision } from '@/i18n/use-ui-language-revision'
import type { BotGroupRemoteAsk as RemoteAsk } from '../../../../shared/bots/bot-group'
import { NativeChatMarkdown } from '../native-chat/markdown/NativeChatMarkdown'
import { BotAvatar } from './BotAvatar'

/** A bot on another computer, asked by mail: its answer as text when it arrives, else where the
 *  question stands. No live work, tools or approvals show here; they stay on that computer. */
export function BotGroupRemoteAsk({ ask }: { ask: RemoteAsk }): React.JSX.Element {
  const t = useTranslate()
  useUiLanguageRevision()
  const values = { bot: ask.name, computer: ask.computer }
  const answer = ask.reply?.kind === 'answer' ? ask.reply.text : null
  // The row label is short metadata beside the name; sentences go on the line under it.
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
  const problem = answer === null && (ask.state === 'failed' || ask.state === 'unknown')
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
  return (
    <section
      data-group-remote-ask={ask.requestId}
      data-group-bot={`${ask.environmentId}:${ask.botId}`}
      className="space-y-2"
    >
      <div className="flex min-w-0 items-center gap-2">
        <BotAvatar
          bot={{
            id: ask.botId,
            hostId: `runtime:${ask.environmentId}`,
            name: ask.name,
            avatar: ask.avatar,
            avatarColor: ask.avatarColor,
            avatarOutfit: ask.avatarOutfit
          }}
          className="size-6 shrink-0 rounded-md text-xs"
        />
        {/* The name gives way first: the status is short and says where the question stands. */}
        <span
          title={ask.name}
          className="min-w-12 shrink truncate text-sm font-medium text-chat-foreground"
        >
          {ask.name}
        </span>
        {ask.state === 'sending' && answer === null && !ask.reply && !ask.stopped ? (
          <LoaderCircle
            aria-hidden
            className="size-3 shrink-0 animate-spin text-chat-foreground-faint"
          />
        ) : null}
        <span
          // Present in every state, so a live change to a problem is announced.
          role="status"
          title={status}
          className={
            problem
              ? 'max-w-[70%] shrink-0 truncate text-xs text-chat-warning'
              : 'max-w-[70%] shrink-0 truncate text-xs text-chat-foreground-faint'
          }
        >
          {status}
        </span>
      </div>
      {detail ? <p className="text-xs text-chat-foreground-faint">{detail}</p> : null}
      {answer !== null ? <NativeChatMarkdown content={answer} variant="document" /> : null}
      {ask.reply?.kind === 'answer' && ask.reply.truncated ? (
        <p className="text-xs text-chat-foreground-faint">
          {t('bots.groups.remoteShortened', 'Shortened. Full answer is on {{computer}}.', values)}
        </p>
      ) : null}
    </section>
  )
}

/** A reason as a sentence, so the line under it can follow. */
function sentence(text: string): string {
  const trimmed = text.trim()
  return trimmed === '' || /[.!?…]$/.test(trimmed) ? trimmed : `${trimmed}.`
}
