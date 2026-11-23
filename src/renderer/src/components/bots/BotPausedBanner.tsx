import React, { useState } from 'react'
import { Pause } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { useTranslate } from '@/i18n/use-translate'
import { updateBot } from '@/lib/bot-catalog'
import type { Bot } from '../../../../shared/bot-types'
import { botErrorMessage } from './bot-presentation'

/** Across the top of a paused bot's page until it is resumed. */
export function BotPausedBanner({ bot }: { bot: Bot }): React.JSX.Element {
  const t = useTranslate()
  const [resuming, setResuming] = useState(false)
  const resume = (): void => {
    setResuming(true)
    updateBot(bot, { paused: false })
      .catch((error: unknown) => toast.error(botErrorMessage(error)))
      .finally(() => setResuming(false))
  }
  return (
    <div
      role="status"
      className="flex shrink-0 items-center gap-2.5 border-b border-status-warning-border bg-status-warning-background py-1.5 pr-2 pl-3 text-xs"
    >
      <Pause className="size-4 shrink-0 text-status-warning" aria-hidden="true" />
      <p className="min-w-0 flex-1 font-medium text-foreground">
        {t('bots.paused.banner', 'Paused. Nothing runs for you until you turn it back on.')}
      </p>
      <Button type="button" variant="outline" size="xs" disabled={resuming} onClick={resume}>
        {t('bots.paused.resume', 'Resume')}
      </Button>
    </div>
  )
}
