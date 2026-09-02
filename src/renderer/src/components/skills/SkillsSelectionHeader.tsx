import { X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'
import { selectedCountLabel } from './skill-display-labels'
import { SKILLS_PAGE_COLUMN } from './skills-page-column'
import { SKILLS_SUBTITLE_ACTION_CLASS } from './skills-subtitle-action'

/**
 * Selection takes over the page header instead of opening a bar somewhere else:
 * the submit lands in the slot the user just clicked, and `✕` keeps meaning what
 * Esc means — leave the mode, not the page.
 */
export function SkillsSelectionHeader({
  title,
  icon,
  actionIcon,
  actionLabel,
  destructive = false,
  busy = false,
  selectedCount,
  eligibleCount,
  onSelectAll,
  onClear,
  onCancel,
  onSubmit
}: {
  /** Copy is passed in already translated: this header's own key namespace
   *  cannot own strings for two unrelated modes. */
  title: string
  icon: React.JSX.Element
  actionIcon: React.JSX.Element
  actionLabel: string
  destructive?: boolean
  /** Keeps a slow remote submit from being fired twice. */
  busy?: boolean
  selectedCount: number
  eligibleCount: number
  onSelectAll: () => void
  onClear: () => void
  onCancel: () => void
  onSubmit: () => void
}): React.JSX.Element {
  return (
    <header className="shrink-0 border-b border-border">
      <div className={cn(SKILLS_PAGE_COLUMN, 'flex items-center gap-2 py-3')}>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="size-7 shrink-0 rounded-full"
              onClick={onCancel}
              aria-label={translate(
                'auto.components.skills.SkillsSelectionHeader.exit',
                'Exit selection'
              )}
            >
              <X className="size-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom" sideOffset={6}>
            {translate(
              'auto.components.skills.SkillsSelectionHeader.exitTooltip',
              'Exit selection · Esc'
            )}
          </TooltipContent>
        </Tooltip>
        <div className="mx-1 h-5 w-px bg-border/50" aria-hidden />
        {icon}
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-sm font-semibold">{title}</h1>
          <div className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
            <span className="shrink-0" role="status" aria-live="polite">
              {selectedCountLabel(selectedCount)}
            </span>
            <span aria-hidden>·</span>
            <Button
              type="button"
              variant="link"
              className={SKILLS_SUBTITLE_ACTION_CLASS}
              disabled={eligibleCount === 0}
              onClick={onSelectAll}
            >
              {translate(
                'auto.components.skills.SkillsSelectionHeader.selectAll',
                'Select all {{count}} eligible',
                { count: eligibleCount }
              )}
            </Button>
            <span aria-hidden>·</span>
            <Button
              type="button"
              variant="link"
              className={SKILLS_SUBTITLE_ACTION_CLASS}
              disabled={selectedCount === 0}
              onClick={onClear}
            >
              {translate('auto.components.skills.SkillsSelectionHeader.clear', 'Clear')}
            </Button>
          </div>
        </div>
        <Button
          type="button"
          size="sm"
          variant={destructive ? 'destructive' : 'default'}
          disabled={selectedCount === 0 || busy}
          onClick={onSubmit}
        >
          {actionIcon}
          {actionLabel}
        </Button>
      </div>
    </header>
  )
}
