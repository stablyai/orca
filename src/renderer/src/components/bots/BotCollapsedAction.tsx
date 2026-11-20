import type { Ref } from 'react'
import { LayoutTemplate, Plus } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useTranslate } from '@/i18n/use-translate'
import { openBotTemplates } from './templates/bot-templates-open'

export function BotCollapsedAction({
  showTemplates,
  onAddBot,
  addButtonRef
}: {
  showTemplates: boolean
  onAddBot: () => void
  addButtonRef: Ref<HTMLButtonElement>
}) {
  const t = useTranslate()
  if (showTemplates) {
    return (
      <Button
        type="button"
        size="xs"
        variant="ghost"
        className="max-w-24"
        onClick={() => openBotTemplates()}
      >
        <LayoutTemplate />
        <span className="truncate">{t('bots.section.emptyTemplates', 'Templates')}</span>
      </Button>
    )
  }

  const label = t('bots.section.newBot', 'New bot')
  return (
    <span className="flex can-hover:opacity-0 group-hover/sidebar-header:opacity-100 group-focus-within/sidebar-header:opacity-100">
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            ref={addButtonRef}
            type="button"
            size="icon-xs"
            variant="ghost"
            aria-label={label}
            onClick={onAddBot}
          >
            <Plus />
          </Button>
        </TooltipTrigger>
        <TooltipContent side="top">{label}</TooltipContent>
      </Tooltip>
    </span>
  )
}
