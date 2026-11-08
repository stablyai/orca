import { CircleCheck, CircleX } from 'lucide-react'
import { useTranslate } from '@/i18n/use-translate'
import { cn } from '@/lib/utils'
import type { NativeChatTextBlock } from '../../../../shared/native-chat/native-chat-types'
import {
  parsePullRequestEventItemId,
  pullRequestEventCommitUrl,
  pullRequestEventPullRequestUrl,
  pullRequestEventShortSha
} from '../../../../shared/native-chat/native-chat-pull-request-event'
import { NATIVE_CHAT_CI_RESULT_LINES_SETTING_SECTION_ID } from '../settings/chat/native-chat-ci-result-lines-setting-target'
import {
  NativeChatCardHideButton,
  NATIVE_CHAT_HIDEABLE_CARD_CLASS
} from './messages/disclosure/NativeChatCardHideButton'
import { useNativeChatLinkClick } from './links/actions/native-chat-link-click-context'

function LineLink({
  href,
  className,
  children
}: {
  href: string
  className?: string
  children: React.ReactNode
}): React.JSX.Element {
  const onLinkClick = useNativeChatLinkClick()
  return (
    <a
      href={href}
      onClick={(event) => onLinkClick?.(event, href)}
      className={cn(
        'rounded-sm text-chat-foreground-faint underline-offset-2 hover:text-chat-foreground hover:underline focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
        className
      )}
    >
      {children}
    </a>
  )
}

/** "CI failing on orca#3 at 8d5f74b": a one-line card per finished CI result, hideable like the other chat cards. */
export function NativeChatPullRequestEventLine({
  block,
  messageId
}: {
  block: NativeChatTextBlock
  messageId?: string
}): React.JSX.Element {
  const t = useTranslate()
  const event = messageId ? parsePullRequestEventItemId(messageId) : null
  const failing = block.tone === 'failure'
  const Icon = failing ? CircleX : CircleCheck
  return (
    <div
      className={`${NATIVE_CHAT_HIDEABLE_CARD_CLASS} rounded-lg border border-chat-code-border p-2 text-sm`}
    >
      <div className="flex min-w-0 items-center gap-1.5 px-1 text-xs text-chat-foreground-faint">
        <Icon
          aria-hidden
          className={cn('size-3.5 shrink-0', failing ? 'text-destructive' : 'text-status-success')}
        />
        {event ? (
          // Only the lead and PR name truncate, and all of it opens the PR, so both links stay reachable.
          <span className="flex min-w-0">
            <LineLink href={pullRequestEventPullRequestUrl(event)} className="min-w-0 truncate">
              {failing
                ? t('components.native-chat.ciResultLine.failingLead', 'CI failing on')
                : t('components.native-chat.ciResultLine.greenLead', 'CI green on')}{' '}
              {`${event.repo}#${event.number}`}
            </LineLink>
            <span className="shrink-0 whitespace-pre">
              {' '}
              {t('components.native-chat.ciResultLine.at', 'at')}{' '}
              <LineLink href={pullRequestEventCommitUrl(event)}>
                {pullRequestEventShortSha(event.headSha)}
              </LineLink>
            </span>
          </span>
        ) : (
          <span className="min-w-0 truncate">{block.text}</span>
        )}
        <NativeChatCardHideButton
          updates={{ nativeChatCiResultLines: false }}
          settingSectionId={NATIVE_CHAT_CI_RESULT_LINES_SETTING_SECTION_ID}
          hiddenMessage={t(
            'components.native-chat.ciResultLine.hidden',
            "Orca won't show CI result lines anymore"
          )}
          ariaLabel={t('components.native-chat.ciResultLine.hide', "Don't show CI result lines")}
        />
      </div>
    </div>
  )
}
