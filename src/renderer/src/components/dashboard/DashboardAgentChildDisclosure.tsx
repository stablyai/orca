import React, { useCallback } from 'react'
import { ChevronRight } from 'lucide-react'
import { cn } from '@/lib/utils'

type Props = {
  childAgentCount?: number
  childAgentsExpanded: boolean
  onToggleChildAgents?: () => void
  reserveDisclosureGutter: boolean
}

export function DashboardAgentChildDisclosure({
  childAgentCount,
  childAgentsExpanded,
  onToggleChildAgents,
  reserveDisclosureGutter
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
    return reserveDisclosureGutter ? (
      <span aria-hidden className="-ml-0.5 inline-block size-4 shrink-0" />
    ) : null
  }

  // Why: the chevron owns child disclosure; leaf spacers keep the leading
  // state-dot column aligned across the card.
  return (
    <button
      type="button"
      onClick={handleToggleChildren}
      onMouseDown={stopMouseDown}
      onKeyDown={stopKeyDown}
      className="-ml-0.5 inline-flex size-4 shrink-0 items-center justify-center rounded-sm text-muted-foreground hover:bg-sidebar-accent hover:text-foreground"
      aria-label={`${childAgentsExpanded ? 'Hide' : 'Show'} ${childAgentCount} child ${
        childAgentCount === 1 ? 'agent' : 'agents'
      }`}
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
