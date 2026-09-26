import React, { useCallback } from 'react'
import { ChevronRight } from 'lucide-react'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'

type Props = {
  childAgentCount?: number
  childAgentsExpanded: boolean
  onToggleChildAgents?: () => void
}

export function DashboardAgentChildDisclosure({
  childAgentCount,
  childAgentsExpanded,
  onToggleChildAgents
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
    <button
      type="button"
      onClick={handleToggleChildren}
      onMouseDown={stopMouseDown}
      onKeyDown={stopKeyDown}
      className="-ml-0.5 inline-flex size-4 shrink-0 items-center justify-center rounded-sm border border-sidebar-border/80 bg-sidebar text-foreground/80 shadow-xs hover:bg-sidebar-accent hover:text-foreground"
      aria-label={translate(
        'auto.components.dashboard.DashboardAgentChildDisclosure.1b57ce9fa4',
        '{{value0}} {{value1}} child {{value2}}',
        {
          value0: childAgentsExpanded
            ? translate('common.childAgentDisclosure.hide', 'Hide')
            : translate('common.childAgentDisclosure.show', 'Show'),
          value1: childAgentCount,
          value2:
            childAgentCount === 1
              ? translate('common.childAgentDisclosure.agent', 'agent')
              : translate('common.childAgentDisclosure.agents', 'agents')
        }
      )}
      aria-expanded={childAgentsExpanded}
    >
      <ChevronRight
        className={cn(
          'size-3 transition-transform duration-150',
          childAgentsExpanded && 'rotate-90'
        )}
      />
    </button>
  )
}
