import { LoaderCircle } from 'lucide-react'
import { useTranslate } from '@/i18n/use-translate'
import { useUiLanguageRevision } from '@/i18n/use-ui-language-revision'
import type { BotGroupRemoteCard } from '../../../../shared/bots/bot-group-schema'
import { botGroupRemoteAskLines } from '../../../../shared/bots/bot-group-remote-ask-lines'
import { quietBotAnswer } from '../../../../shared/bot-quiet-result'
import { NativeChatMarkdown } from '../native-chat/markdown/NativeChatMarkdown'
import { BotAvatar } from './BotAvatar'

/** A bot on another computer, asked by mail: its answer as text when it arrives, else where the
 *  question stands. No live work, tools or approvals show here; they stay on that computer. */
export function BotGroupRemoteAsk(props: BotGroupRemoteCard): React.JSX.Element {
  const t = useTranslate()
  useUiLanguageRevision()
  const ask = 'ask' in props ? props.ask : null
  const author = 'author' in props ? props.author : props.ask
  const { answer, status, problem, detail, shortened } =
    'ask' in props
      ? botGroupRemoteAskLines(props.ask, t)
      : { answer: props.text, status: null, problem: false, detail: null, shortened: null }
  // A bot's answer, as on the phone: a quiet result never draws its marker.
  const quiet =
    answer === null
      ? null
      : quietBotAnswer(answer, {
          botAnswer: true,
          streaming: false,
          inAutomationTurn: false,
          inActingTurn: false
        })
  return (
    <section
      data-group-remote-ask={ask?.requestId}
      data-group-bot={`${author.environmentId}:${author.botId}`}
      data-group-remote-post={'postId' in props ? props.postId : undefined}
      className="space-y-2"
    >
      <div className="flex min-w-0 items-center gap-2">
        <BotAvatar
          bot={{
            id: author.botId,
            hostId: `runtime:${author.environmentId}`,
            name: author.name,
            avatar: author.avatar,
            avatarColor: author.avatarColor,
            avatarOutfit: author.avatarOutfit
          }}
          className="size-6 shrink-0 rounded-md text-xs"
        />
        {/* The name gives way first: the status is short and says where the question stands. */}
        <span
          title={author.name}
          className="min-w-12 shrink truncate text-sm font-medium text-chat-foreground"
        >
          {author.name}
        </span>
        {ask?.state === 'sending' && answer === null && !ask.reply && !ask.stopped ? (
          <LoaderCircle
            aria-hidden
            className="size-3 shrink-0 animate-spin text-chat-foreground-faint"
          />
        ) : null}
        {status ? (
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
        ) : null}
      </div>
      {detail ? <p className="text-xs text-chat-foreground-faint">{detail}</p> : null}
      {quiet?.words ? <NativeChatMarkdown content={quiet.words} variant="document" /> : null}
      {quiet?.nothingToReport ? (
        <p className="text-xs text-chat-foreground-faint">
          {t('bots.chat.nothingToReport', 'Nothing to report')}
        </p>
      ) : null}
      {shortened ? <p className="text-xs text-chat-foreground-faint">{shortened}</p> : null}
    </section>
  )
}
