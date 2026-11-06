import { CircleCheck, CircleX } from 'lucide-react'
import { translate } from '@/i18n/i18n'
import { cn } from '@/lib/utils'
import { EyeOffDismissButton } from '@/components/dismiss/EyeOffDismissButton'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import type { NativeChatTextBlock } from '../../../../shared/native-chat/native-chat-types'
import {
  parsePullRequestEventItemId,
  pullRequestEventShortSha
} from '../../../../shared/native-chat/native-chat-pull-request-event'
import { NATIVE_CHAT_CI_RESULT_LINES_SETTING_SECTION_ID } from '../settings/chat/native-chat-ci-result-lines-setting-target'
import { hideNativeChatCardKind } from './native-chat-card-kind-hidden-toast'
import { useNativeChatLinkClick } from './native-chat-link-click-context'

// Mirrors the shared card hide control's API (`updates`, `settingSectionId`, `failedMessage`), so
// swapping in that component is an import change.
function NativeChatCardHideButton({
  label,
  updates,
  settingSectionId,
  failedMessage,
  className
}: {
  label: string
  updates: Partial<GlobalSettings>
  settingSectionId: string
  failedMessage: string
  className?: string
}): React.JSX.Element {
  return (
    <EyeOffDismissButton
      label={label}
      onClick={() => hideNativeChatCardKind(updates, settingSectionId, failedMessage)}
      className={className}
    />
  )
}

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
  const event = messageId ? parsePullRequestEventItemId(messageId) : null
  const failing = block.tone === 'failure'
  const Icon = failing ? CircleX : CircleCheck
  return (
    <div className="group/ci-line flex h-6 min-w-0 items-center justify-center gap-1.5 text-xs text-chat-foreground-faint">
      <Icon
        aria-hidden
        className={cn(
          'size-3.5 shrink-0',
          failing ? 'text-rose-600 dark:text-rose-300' : 'text-emerald-600 dark:text-emerald-300'
        )}
      />
      {event ? (
        <span className="min-w-0 truncate">
          {failing
            ? translate('components.native-chat.ciResultLine.failingLead', 'CI failing on')
            : translate('components.native-chat.ciResultLine.greenLead', 'CI green on')}{' '}
          <LineLink
            href={`https://${event.forgeHost}/${event.owner}/${event.repo}/pull/${event.number}`}
          >{`${event.repo}#${event.number}`}</LineLink>{' '}
          {translate('components.native-chat.ciResultLine.at', 'at')}{' '}
          <LineLink
            href={`https://${event.forgeHost}/${event.owner}/${event.repo}/commit/${event.headSha}`}
          >
            {pullRequestEventShortSha(event.headSha)}
          </LineLink>
        </span>
      ) : (
        <span className="min-w-0 truncate">{block.text}</span>
      )}
      <NativeChatCardHideButton
        label={translate('components.native-chat.ciResultLine.hide', "Don't show CI result lines")}
        updates={{ nativeChatCiResultLines: false }}
        settingSectionId={NATIVE_CHAT_CI_RESULT_LINES_SETTING_SECTION_ID}
        failedMessage={translate(
          'components.native-chat.ciResultLine.hideFailed',
          "Couldn't hide CI result lines. Try again, or turn off CI result lines in Settings › Chat UI."
        )}
        className="opacity-0 focus-visible:opacity-100 group-focus-within/ci-line:opacity-100 group-hover/ci-line:opacity-100"
      />
    </div>
  )
}
