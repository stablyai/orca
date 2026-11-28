import React from 'react'
import { EyeOff } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useTranslate } from '@/i18n/use-translate'

/** The tag and its accessible hint, shared by the sidebar row and Cmd+J. */
export function useFilterHiddenCopy(): { label: string; hint: string } {
  const t = useTranslate()
  return {
    label: t('sidebar.filterHidden.label', 'Hidden'),
    hint: t('sidebar.filterHidden.hint', 'Hidden by sidebar filters')
  }
}

/** Marks a workspace listed although the sidebar filters hide it (the active row, a search match). */
export function FilterHiddenBadge({
  className,
  withTooltip = false
}: {
  className?: string
  withTooltip?: boolean
}): React.JSX.Element {
  const { label, hint } = useFilterHiddenCopy()
  const badge = (
    <Badge
      variant="referenceLabel"
      className={className}
      aria-label={hint}
      data-filter-hidden-badge=""
    >
      <EyeOff aria-hidden="true" />
      {label}
    </Badge>
  )
  if (!withTooltip) {
    return badge
  }
  return (
    <Tooltip>
      <TooltipTrigger asChild>{badge}</TooltipTrigger>
      <TooltipContent side="right" sideOffset={8}>
        {hint}
      </TooltipContent>
    </Tooltip>
  )
}
