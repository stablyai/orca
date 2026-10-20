import React from 'react'
import { EyeOff } from 'lucide-react'
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip'
import { translate } from '@/i18n/i18n'

/** Marks an incognito project while unlocked, so the user knows it hides again on lock. */
export function RepoIncognitoIndicator({
  incognito
}: {
  incognito: boolean | undefined
}): React.JSX.Element | null {
  if (incognito !== true) {
    return null
  }
  const label = translate(
    'incognitoProjects.indicatorTooltip',
    'Incognito project — hidden when incognito projects are locked'
  )
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          className="inline-flex shrink-0 items-center text-muted-foreground"
          aria-label={label}
        >
          <EyeOff className="size-3" aria-hidden="true" />
        </span>
      </TooltipTrigger>
      <TooltipContent side="top" sideOffset={4}>
        {label}
      </TooltipContent>
    </Tooltip>
  )
}
