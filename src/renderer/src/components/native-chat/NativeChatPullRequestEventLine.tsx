import { CircleCheck, CircleX } from 'lucide-react'
import { useTranslate } from '@/i18n/use-translate'
import { cn } from '@/lib/utils'
import type { NativeChatTextBlock } from '../../../../shared/native-chat/native-chat-types'
import {
  parsePullRequestEventItemId,
  pullRequestEventShortSha
} from '../../../../shared/native-chat/native-chat-pull-request-event'
import { NATIVE_CHAT_CI_RESULT_LINES_SETTING_SECTION_ID } from '../settings/chat/native-chat-ci-result-lines-setting-target'
import {
  NativeChatCardHideButton,
  NATIVE_CHAT_HIDEABLE_CARD_CLASS
} from './messages/disclosure/NativeChatCardHideButton'
import { useNativeChatLinkClick } from './links/actions/native-chat-link-click-context'

function LineLink({ href, children }: { href: string; children: string }): React.JSX.Element {
  const onLinkClick = useNativeChatLinkClick()
  return (
    <a
      href={href}
      onClick={(event) => onLinkClick?.(event, href)}
      className="rounded-sm text-chat-foreground-faint underline-offset-2 hover:text-chat-foreground hover:underline focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
    >
      {children}
    </a>
  )
}

/** "CI failing on orca#3 at 8d5f74b": one quiet centered line per finished CI result. */
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
      className={cn(
        NATIVE_CHAT_HIDEABLE_CARD_CLASS,
        'relative flex h-6 min-w-0 items-center justify-center gap-1.5 px-6 text-xs text-chat-foreground-faint'
      )}
    >
      <Icon
        aria-hidden
        className={cn('size-3.5 shrink-0', failing ? 'text-destructive' : 'text-status-success')}
      />
      {event ? (
        <span className="min-w-0 truncate">
          {failing
            ? t('components.native-chat.ciResultLine.failingLead', 'CI failing on')
            : t('components.native-chat.ciResultLine.greenLead', 'CI green on')}{' '}
          <LineLink
            href={`https://${event.forgeHost}/${event.owner}/${event.repo}/pull/${event.number}`}
          >{`${event.repo}#${event.number}`}</LineLink>{' '}
          {t('components.native-chat.ciResultLine.at', 'at')}{' '}
          <LineLink
            href={`https://${event.forgeHost}/${event.owner}/${event.repo}/commit/${event.headSha}`}
          >
            {pullRequestEventShortSha(event.headSha)}
          </LineLink>
        </span>
      ) : (
        <span className="min-w-0 truncate">{block.text}</span>
      )}
      {/* Pinned to the row's end, so the centered line doesn't shift when it shows; the row's
          padding, the button's width on both sides, keeps long text from running under it. */}
      <span className="absolute inset-y-0 right-0 flex items-center">
        <NativeChatCardHideButton
          updates={{ nativeChatCiResultLines: false }}
          settingSectionId={NATIVE_CHAT_CI_RESULT_LINES_SETTING_SECTION_ID}
          hiddenMessage={t(
            'components.native-chat.ciResultLine.hidden',
            "Orca won't show CI result lines anymore"
          )}
          ariaLabel={t('components.native-chat.ciResultLine.hide', "Don't show CI result lines")}
        />
      </span>
    </div>
  )
}
