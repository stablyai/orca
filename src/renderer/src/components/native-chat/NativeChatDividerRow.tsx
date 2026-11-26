import { useNowSnapshot } from '@/lib/window-activity/use-now'
import { cn } from '@/lib/class-names'
import { useTranslation } from 'react-i18next'
import { useTranslate } from '@/i18n/use-translate'
import type { ReactNode } from 'react'

/** A quiet line across the transcript with a label in the middle. */
export function NativeChatDividerRow({
  label,
  tone = 'default',
  children
}: {
  label: string
  tone?: 'default' | 'unread'
  children?: ReactNode
}): React.JSX.Element {
  return (
    <div
      role="separator"
      aria-label={label}
      className={cn(
        'flex items-center gap-3 py-2 text-xs text-chat-foreground-faint',
        tone === 'unread' && 'font-semibold text-chat-unread'
      )}
    >
      <span
        aria-hidden
        className={cn('h-px flex-1', tone === 'unread' ? 'bg-chat-unread/50' : 'bg-border')}
      />
      <span className="flex items-center gap-1">{children ?? label}</span>
      <span
        aria-hidden
        className={cn('h-px flex-1', tone === 'unread' ? 'bg-chat-unread/50' : 'bg-border')}
      />
    </div>
  )
}

const calendarDay = (now: number): string => new Date(now).toDateString()

export function NativeChatTimeDivider({ timestamp }: { timestamp: number }): React.JSX.Element {
  const t = useTranslate()
  const { i18n } = useTranslation()
  const at = new Date(timestamp)
  const day = useNowSnapshot(60_000, calendarDay)
  const today = at.toDateString() === day
  const label = today
    ? t('components.native-chat.messaging.todayAt', 'Today {{time}}', {
        time: new Intl.DateTimeFormat(i18n.language, { timeStyle: 'short' }).format(at)
      })
    : new Intl.DateTimeFormat(i18n.language, { dateStyle: 'medium', timeStyle: 'short' }).format(at)
  return <NativeChatDividerRow label={label} />
}
