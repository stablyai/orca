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
  const status =
    answer !== null
      ? t('bots.groups.remoteReplied', 'Replied on {{computer}}.', values)
      : ask.reply?.kind === 'notice'
        ? t('bots.groups.remoteNotice', "{{bot}} on {{computer}} didn't answer.", values)
        : ask.state === 'failed'
          ? t('bots.groups.remoteNotSent', 'Not sent to {{computer}}.', values)
          : ask.state === 'unknown'
            ? t(
                'bots.groups.remoteUnknown',
                'Delivery unknown. {{bot}} may still answer on {{computer}}.',
                values
              )
            : ask.stopped
              ? t(
                  'bots.groups.remoteStopped',
                  'Stopped here. {{bot}} may still answer on {{computer}}.',
                  values
                )
              : ask.state === 'sending'
                ? t('bots.groups.remoteSending', 'Asking on {{computer}}…', values)
                : t('bots.groups.remoteAsked', 'Asked on {{computer}}', values)
  const problem = answer === null && (ask.state === 'failed' || ask.state === 'unknown')
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
            avatarColor: ask.avatarColor
          }}
          className="size-6 shrink-0 rounded-md text-xs"
        />
        <span className="truncate text-sm font-medium text-chat-foreground">{ask.name}</span>
        <span
          role={problem ? 'alert' : undefined}
          className={
            problem
              ? 'truncate text-xs text-chat-warning'
              : 'truncate text-xs text-chat-foreground-faint'
          }
        >
          {status}
        </span>
      </div>
      {problem && ask.error ? (
        <p className="text-xs text-chat-foreground-faint">{ask.error}</p>
      ) : null}
      {answer !== null ? <NativeChatMarkdown content={answer} variant="document" /> : null}
      {ask.reply?.kind === 'answer' && ask.reply.truncated ? (
        <p className="text-xs text-chat-foreground-faint">
          {t('bots.groups.remoteShortened', 'Shortened here; the full answer is longer.')}
        </p>
      ) : null}
    </section>
  )
}
