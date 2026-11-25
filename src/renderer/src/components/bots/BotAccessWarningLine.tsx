import React from 'react'
import { TriangleAlert } from 'lucide-react'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useTranslate } from '@/i18n/use-translate'
import type { Bot } from '../../../../shared/bot-types'
import { BOT_ACCESS_COPY } from '../../../../shared/bots/bot-access-copy'
import { botAccessSummary } from '../../../../shared/bots/bot-access-reach'
import { useBotAccessPlace } from './use-bot-access-place'

/** Once someone else can ask: one warning line, the full control sentence on hover and for screen readers. */
export function BotAccessWarningLine({
  bot,
  others
}: {
  bot: Bot
  others: readonly string[]
}): React.JSX.Element {
  const t = useTranslate()
  const place = useBotAccessPlace(bot.hostId)
  const { control } = botAccessSummary(others)
  const full = t(`bots.access.${control.id}`, BOT_ACCESS_COPY[control.id], {
    ...control.values,
    name: bot.name,
    ...place
  })
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        {/* Focusable so the full sentence's tooltip opens from the keyboard too. */}
        <p
          tabIndex={0}
          className="mt-2 flex min-w-0 items-center gap-1.5 rounded-sm text-xs text-status-warning-text outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
        >
          <TriangleAlert className="size-3.5 shrink-0" aria-hidden />
          <span aria-hidden className="min-w-0 truncate">
            {t('bots.access.actsAsYou', BOT_ACCESS_COPY.actsAsYou, place)}
          </span>
          <span className="sr-only">{full}</span>
        </p>
      </TooltipTrigger>
      <TooltipContent side="bottom" className="max-w-72">
        {full}
      </TooltipContent>
    </Tooltip>
  )
}
