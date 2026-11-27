import { X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { RailPageBand } from '@/components/rail-page/RailPageHeader'
import { useTranslate } from '@/i18n/use-translate'
import { selectedCountLabel } from '../presentation/skill-display-labels'
import { SKILLS_SUBTITLE_ACTION_CLASS } from './skills-subtitle-action'

/** Keep submit in the header’s action slot; close and Escape leave selection mode before leaving the page. */
export function SkillsSelectionHeader({
  refresh,
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
  /** Callers supply translated mode-specific copy instead of sharing this header’s namespace. */
  refresh: React.ReactNode
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
  const t = useTranslate()
  return (
    <RailPageBand className="gap-2">
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="icon-toolbar"
            onClick={onCancel}
            aria-label={t('auto.components.skills.SkillsSelectionHeader.exit', 'Exit selection')}
          >
            <X className="size-4" />
          </Button>
        </TooltipTrigger>
        <TooltipContent side="bottom" sideOffset={6}>
          {t('auto.components.skills.SkillsSelectionHeader.exitTooltip', 'Exit selection · Esc')}
        </TooltipContent>
      </Tooltip>
      <div className="mx-1 h-5 w-px bg-border/50" aria-hidden />
      {icon}
      <div className="min-w-0 flex-1">
        <h1 className="truncate text-sm font-semibold">{title}</h1>
        <div className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
          <span className="shrink-0" role="status" aria-live="polite">
            {selectedCountLabel(selectedCount, t)}
          </span>
          <span aria-hidden>·</span>
          <Button
            type="button"
            variant="link"
            className={SKILLS_SUBTITLE_ACTION_CLASS}
            disabled={eligibleCount === 0}
            onClick={onSelectAll}
          >
            {t(
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
            {t('auto.components.skills.SkillsSelectionHeader.clear', 'Clear')}
          </Button>
        </div>
      </div>
      {refresh}
      <Button
        type="button"
        size="toolbar"
        aria-label={actionLabel}
        variant={destructive ? 'destructive' : 'default'}
        disabled={selectedCount === 0 || busy}
        onClick={onSubmit}
      >
        {actionIcon}
        <span className="@max-[40rem]/rail-page:hidden">{actionLabel}</span>
      </Button>
    </RailPageBand>
  )
}
