import type { JSX } from 'react'
import { List, ListTree } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { translate } from '@/i18n/i18n'
import type { SourceControlViewMode } from '../../../../shared/types'

export function SourceControlViewModeToggle({
  viewMode,
  disabled,
  onToggle
}: {
  viewMode: SourceControlViewMode
  disabled?: boolean
  onToggle: () => void
}): JSX.Element {
  const isTree = viewMode === 'tree'
  // Why: the icon and label name the action — switching to the other mode — not the current view.
  const label = isTree
    ? translate(
        'auto.components.right.sidebar.SourceControlViewModeToggle.3e1e60f138',
        'Show changes as list'
      )
    : translate(
        'auto.components.right.sidebar.SourceControlViewModeToggle.3b429e0f68',
        'Show changes as tree'
      )
  const Icon = isTree ? List : ListTree
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          className="shrink-0 text-muted-foreground hover:text-foreground"
          aria-label={label}
          disabled={disabled}
          onClick={onToggle}
        >
          <Icon className="size-3.5" />
        </Button>
      </TooltipTrigger>
      <TooltipContent side="bottom" sideOffset={6}>
        {label}
      </TooltipContent>
    </Tooltip>
  )
}
