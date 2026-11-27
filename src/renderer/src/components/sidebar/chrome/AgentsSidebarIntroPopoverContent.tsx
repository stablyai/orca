import React from 'react'
import { Sparkles } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { PopoverArrow, PopoverContent } from '@/components/ui/popover'
import { useTranslate } from '@/i18n/use-translate'

export function AgentsSidebarIntroPopoverContent({
  introTitleId,
  introDescriptionId,
  onAcknowledge
}: {
  introTitleId: string
  introDescriptionId: string
  onAcknowledge: () => void
}): React.JSX.Element {
  const t = useTranslate()
  return (
    <PopoverContent
      side="bottom"
      align="center"
      sideOffset={8}
      className="w-72 rounded-xl border border-border bg-popover p-3.5 text-popover-foreground shadow-floating"
      onOpenAutoFocus={(event) => event.preventDefault()}
      aria-labelledby={introTitleId}
      aria-describedby={introDescriptionId}
    >
      <PopoverArrow />
      <div className="space-y-2.5">
        <div className="flex items-center gap-1.5">
          <Sparkles className="size-4 shrink-0 text-primary" aria-hidden="true" />
          <h3 id={introTitleId} className="text-sm font-semibold text-foreground">
            {t('agentsSidebarIntro.migrated.title', 'Agents are easier to find')}
          </h3>
        </div>
        <p id={introDescriptionId} className="text-xs leading-relaxed text-muted-foreground">
          {t(
            'agentsSidebarIntro.migrated.description',
            'Your Agents view is now a dedicated sidebar tab. Your activity and filters are preserved.'
          )}
        </p>
        <div className="flex justify-end pt-0.5">
          <Button size="sm" onClick={onAcknowledge}>
            {t('agentsSidebarIntro.migrated.dismiss', 'Got it')}
          </Button>
        </div>
      </div>
    </PopoverContent>
  )
}
