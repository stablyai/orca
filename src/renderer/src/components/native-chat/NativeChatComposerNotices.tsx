import { AlertCircle, Paperclip, ServerOff, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
import { cn } from '@/lib/utils'
import { NativeChatCopyButton } from './NativeChatCopyButton'
import type { NativeChatComposerNotice } from './native-chat-composer-notice'

/** One card above the composer, one row per notice, errors first. The live region stays mounted so
 *  a screen reader hears the first notice too. */
export function NativeChatComposerNotices({
  notices,
  className
}: {
  notices: readonly NativeChatComposerNotice[]
  className?: string
}): React.JSX.Element {
  if (notices.length === 0) {
    return <ul aria-live="polite" />
  }
  const ordered = [...notices].sort(
    (a, b) => Number(b.kind === 'error') - Number(a.kind === 'error')
  )
  return (
    <ul
      aria-live="polite"
      className={cn(
        'divide-y divide-border overflow-hidden rounded-md border border-border bg-card text-xs text-card-foreground',
        ordered[0]?.kind === 'error' && 'border-destructive/30',
        className
      )}
    >
      {ordered.map((notice) => (
        <NoticeRow key={notice.key} notice={notice} />
      ))}
    </ul>
  )
}

/** The card where a question or approval card has taken the composer's place. */
export function NativeChatPromptSlotNotices({
  notices
}: {
  notices: readonly NativeChatComposerNotice[]
}): React.JSX.Element {
  return (
    <div
      className={cn(
        notices.length > 0 && 'mx-auto w-full max-w-(--chat-content-max-width) px-3 pt-2 sm:px-4'
      )}
    >
      <NativeChatComposerNotices notices={notices} />
    </div>
  )
}

function NoticeRow({ notice }: { notice: NativeChatComposerNotice }): React.JSX.Element {
  const isError = notice.kind === 'error'
  const isHostWarning = notice.kind === 'host' && notice.tone === 'warning'
  const Icon = notice.kind === 'host' ? ServerOff : isError ? AlertCircle : Paperclip
  const dismissLabel = translate('components.native-chat.notices.dismiss', 'Dismiss')
  return (
    <li data-notice-kind={notice.kind} className={cn(isError && 'bg-destructive/5')}>
      <div className="flex items-start gap-2 px-2.5 py-1.5">
        <Icon
          aria-hidden
          className={cn(
            'mt-0.5 size-3.5 shrink-0',
            'text-muted-foreground',
            isError && 'text-destructive',
            isHostWarning && 'text-destructive'
          )}
        />
        <p
          className={cn(
            'min-w-0 flex-1 select-text py-px leading-5',
            notice.kind === 'host' ? 'truncate' : '[overflow-wrap:anywhere]',
            'text-muted-foreground',
            isError && 'text-foreground',
            isHostWarning && 'text-destructive'
          )}
        >
          {notice.text}
        </p>
        {notice.action ? (
          <Button
            type="button"
            variant="outline"
            size="xs"
            disabled={notice.action.disabled}
            onClick={notice.action.onClick}
          >
            {notice.action.label}
          </Button>
        ) : null}
        {notice.onDismiss ? (
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            aria-label={dismissLabel}
            title={dismissLabel}
            onClick={notice.onDismiss}
          >
            <X />
          </Button>
        ) : null}
      </div>
      {notice.errorText ? (
        <div className="relative mb-2 ml-8 mr-2.5 rounded-md border border-border bg-muted">
          <pre className="scrollbar-sleek max-h-28 select-text overflow-auto whitespace-pre-wrap break-words py-1.5 pl-2 pr-8 font-mono text-[11px] text-foreground">
            {notice.errorText}
          </pre>
          <NativeChatCopyButton
            text={notice.errorText}
            label={translate('components.native-chat.notices.copyError', 'Copy error')}
            className="absolute right-0.5 top-0.5"
          />
        </div>
      ) : null}
    </li>
  )
}
