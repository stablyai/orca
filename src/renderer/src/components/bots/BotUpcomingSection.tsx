// Automations in a bot's Activity panel: Tidy memory, Look around, automations and waits, failed first,
// then running, then soonest; paused ones last. Five show, then "All N automations". Folded, the rows
// in trouble stay listed under the header.
import { ChevronRight, Plus } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useTranslate } from '@/i18n/use-translate'
import { openBotHomeTab } from '@/lib/bot-catalog'
import { useAppStore } from '@/store'
import type { Bot } from '../../../../shared/bot-types'
import type { UpNextState } from '../../../../shared/bots/bot-look-around'
import { BotPanelSection } from './BotPanelSection'
import { useBotPanelFold } from './use-bot-panel-fold'
import {
  AUTOMATION_CARD_CAP,
  botAutomationCardView,
  useAutomationCardOrder,
  type BotAutomationCardRow
} from './bot-automation-card'
import { UpcomingItem } from './BotUpcomingRows'

export function BotUpcomingSection({
  bot,
  rows,
  upNext,
  hasAutomations,
  signInStops,
  now
}: {
  bot: Bot
  /** In the fixed order `botAutomationCardRows` gives; the card ranks them. */
  rows: readonly BotAutomationCardRow[]
  upNext: UpNextState | undefined
  /** It has automations or waits of its own, beyond Tidy memory and Look around. */
  hasAutomations: boolean
  /** Automations whose sign-in stop Needs you lists. */
  signInStops: ReadonlySet<string>
  now: number
}): React.JSX.Element {
  const t = useTranslate()
  const { shown, listed, listedPaused } = botAutomationCardView(useAutomationCardOrder(rows))
  const newLabel = t('bots.automations.new', 'New automation')
  const fold = useBotPanelFold(bot.id, 'automations')
  const item = (row: BotAutomationCardRow, folded: boolean): React.JSX.Element => (
    <UpcomingItem
      key={row.key}
      bot={bot}
      row={row}
      upNext={upNext}
      signInStops={signInStops}
      now={now}
      folded={folded}
    />
  )
  return (
    <BotPanelSection
      title={t('bots.automations.title', 'Automations')}
      fold={fold}
      folded={shown.map((row) => item(row, true))}
      actions={
        // Icon-only, like the Bots header's "+": the tooltip and accessible name carry the label.
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label={newLabel}
              onClick={() =>
                void openBotHomeTab(bot, {
                  draft: t('bots.automations.newDraft', 'Set up an automation that ')
                })
              }
            >
              <Plus />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom" sideOffset={6}>
            {newLabel}
          </TooltipContent>
        </Tooltip>
      }
    >
      {shown.map((row) => item(row, false))}
      {listed > AUTOMATION_CARD_CAP ? (
        <button
          type="button"
          className="flex min-h-7 w-full items-center justify-between gap-2 rounded-sm pr-2 pl-8 text-left text-xs text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          onClick={() => useAppStore.getState().openAutomationsPage()}
        >
          <span className="min-w-0 truncate">
            {t('bots.automations.all', 'All {{count}} automations', { count: listed })}
            {listedPaused > 0
              ? ` · ${t('bots.automations.pausedCount', '{{count}} paused', { count: listedPaused })}`
              : null}
          </span>
          <ChevronRight className="size-3.5 shrink-0" />
        </button>
      ) : null}
      {hasAutomations ? null : (
        <p className="py-1 pr-2 pl-8 text-xs text-muted-foreground">
          {t(
            'bots.upcoming.empty',
            'Ask {{name}} in chat to run something on a schedule or when something happens.',
            { name: bot.name }
          )}
        </p>
      )}
    </BotPanelSection>
  )
}
