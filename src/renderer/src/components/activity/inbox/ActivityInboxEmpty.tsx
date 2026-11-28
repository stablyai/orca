import React from 'react'
import { CheckCheck } from 'lucide-react'
import { useTranslate } from '@/i18n/use-translate'

/** Nothing needs you and every finished turn is read. */
export function ActivityInboxEmpty(): React.JSX.Element {
  const t = useTranslate()
  return (
    <div className="flex flex-col items-center gap-1.5 px-6 py-10 text-center">
      <CheckCheck className="size-5 text-muted-foreground" aria-hidden />
      <span className="text-[13px] font-medium text-foreground">
        {t('activityInbox.caughtUp', 'You’re all caught up')}
      </span>
      <span className="text-xs leading-relaxed text-muted-foreground">
        {t(
          'activityInbox.caughtUpDetail',
          'Agents waiting on you, bots with tasks for you and finished work show up here. Running agents stay on their workspace cards.'
        )}
      </span>
    </div>
  )
}
