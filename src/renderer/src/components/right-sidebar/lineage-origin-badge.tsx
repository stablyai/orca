import React from 'react'
import { Badge } from '@/components/ui/badge'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import type { LineageMatchSource } from '../../../../shared/lineage-discovery-types'
import { translate } from '@/i18n/i18n'

export type LineageOriginBadgeProps = {
  /** Absent on payloads from older hosts; rendered as 'lineage'. */
  matchedBy?: LineageMatchSource
  reasons?: string[]
}

export function LineageOriginBadge({
  matchedBy = 'lineage',
  reasons
}: LineageOriginBadgeProps): React.JSX.Element {
  const hasReasons = reasons !== undefined && reasons.length > 0
  const badge = (
    <Badge variant="outline" data-testid="lineage-origin-badge">
      {matchedBy}
    </Badge>
  )
  if (!hasReasons) {
    return badge
  }
  return (
    <Tooltip>
      <TooltipTrigger asChild>{badge}</TooltipTrigger>
      <TooltipContent side="bottom">
        <div className="font-medium">
          {translate(
            'auto.components.rightSidebar.lineageOrigin.matchedBy',
            'Matched by {{matchedBy}}',
            {
              matchedBy
            }
          )}
        </div>
        <ul className="list-disc pl-4">
          {reasons.map((reason) => (
            <li key={reason}>{reason}</li>
          ))}
        </ul>
      </TooltipContent>
    </Tooltip>
  )
}
