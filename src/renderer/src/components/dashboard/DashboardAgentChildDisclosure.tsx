import React, { useCallback } from 'react'
import { ChevronDown } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'

type Props = {
  childAgentCount?: number
  childAgentsExpanded: boolean
  onToggleChildAgents?: () => void
  timestamp?: React.ReactNode
}

export function DashboardAgentChildDisclosure({
  childAgentCount,
  childAgentsExpanded,
  onToggleChildAgents,
  timestamp
}: Props) {
  const hasChildDisclosure =
    typeof childAgentCount === 'number' &&
    childAgentCount > 0 &&
    typeof onToggleChildAgents === 'function'
  const handleToggleChildren = useCallback(
    (e: React.MouseEvent<HTMLButtonElement>) => {
      e.preventDefault()
      e.stopPropagation()
      onToggleChildAgents?.()
    },
    [onToggleChildAgents]
  )
  const stopMouseDown = useCallback((e: React.MouseEvent) => {
    e.stopPropagation()
  }, [])
  const stopKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.stopPropagation()
    }
  }, [])

  if (!hasChildDisclosure) {
    return null
  }

  return (
    <span
      className="agent-child-disclosure relative inline-grid h-5 min-w-5 shrink-0 items-center justify-items-end"
      data-expanded={childAgentsExpanded}
    >
      <span
        className="agent-child-disclosure-time col-start-1 row-start-1 pointer-events-none"
        aria-hidden
      >
        {timestamp}
      </span>
      {/* Why: align the 12px icon with adjacent row icons while keeping its 24px hit target. */}
      <Button
        variant="ghost"
        size="icon-xs"
        type="button"
        onClick={handleToggleChildren}
        onMouseDown={stopMouseDown}
        onPointerDown={(event) => event.stopPropagation()}
        onKeyDown={stopKeyDown}
        data-agent-child-disclosure-button=""
        className="col-start-1 row-start-1 -mr-1.5"
        aria-label={translate(
          'auto.components.dashboard.DashboardAgentChildDisclosure.1b57ce9fa4',
          '{{value0}} {{value1}} child {{value2}}',
          {
            value0: childAgentsExpanded ? 'Hide' : 'Show',
            value1: childAgentCount,
            value2: childAgentCount === 1 ? 'agent' : 'agents'
          }
        )}
        aria-expanded={childAgentsExpanded}
      >
        <ChevronDown
          className={cn(
            'size-3 transition-transform duration-150',
            childAgentsExpanded && 'rotate-180'
          )}
          aria-hidden
        />
      </Button>
    </span>
  )
}
