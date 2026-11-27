import { GitPullRequest } from 'lucide-react'
import { useTranslate } from '@/i18n/use-translate'
import { cn } from '@/lib/class-names'
import type { NativeChatTextBlock } from '../../../../../../shared/native-chat/native-chat-types'
import {
  parsePullRequestEventItemId,
  pullRequestEventCommitUrl,
  pullRequestEventPullRequestUrl,
  pullRequestEventShortSha
} from '../../../../../../shared/native-chat/transcript/notices/native-chat-pull-request-event'
import { NATIVE_CHAT_CI_RESULT_LINES_SETTING_SECTION_ID } from '../../../settings/chat/native-chat-ci-result-lines-setting-target'
import { NativeChatCardHideButton } from '../disclosure/NativeChatCardHideButton'
import { NativeChatEventRow } from '../events/NativeChatEventRow'
import { useNativeChatLinkClick } from '../../links/actions/native-chat-link-click-context'

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

/** "CI failing on orca#3 at 8d5f74b": a status row per finished CI result, hideable like the other chat cards. */
export function NativeChatPullRequestEventLine({
  block,
  messageId,
  timestamp = null
}: {
  block: NativeChatTextBlock
  messageId?: string
  timestamp?: number | null
}): React.JSX.Element {
  const t = useTranslate()
  const event = messageId ? parsePullRequestEventItemId(messageId) : null
  const failing = block.tone === 'failure'
  return (
    <NativeChatEventRow
      icon={<GitPullRequest aria-hidden className="size-3.5" />}
      badge={failing ? 'failed' : null}
      timestamp={timestamp}
      action={
        <NativeChatCardHideButton
          inline
          updates={{ nativeChatCiResultLines: false }}
          settingSectionId={NATIVE_CHAT_CI_RESULT_LINES_SETTING_SECTION_ID}
          hiddenMessage={t(
            'components.native-chat.ciResultLine.hidden',
            "Orca won't show CI result lines anymore"
          )}
          ariaLabel={t('components.native-chat.ciResultLine.hide', "Don't show CI result lines")}
        />
      }
    >
      {event ? (
        // Only the lead and PR name truncate, so the commit link always stays reachable.
        <span className="flex min-w-0">
          <LineLink href={pullRequestEventPullRequestUrl(event)} className="min-w-0 truncate">
            {failing
              ? t('components.native-chat.ciResultLine.failingLead', 'CI failing on')
              : t('components.native-chat.ciResultLine.greenLead', 'CI green on')}{' '}
            <span className="text-chat-foreground">{`${event.repo}#${event.number}`}</span>
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
        block.text
      )}
    </NativeChatEventRow>
  )
}
