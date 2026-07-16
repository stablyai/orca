import React, { useCallback } from 'react'
import { ChevronRight } from 'lucide-react'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'

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

  // Why: translating the full action avoids leaking English verbs and plural nouns into CJK labels.
  const disclosureLabel = childAgentsExpanded
    ? childAgentCount === 1
      ? translate(
          'auto.components.dashboard.DashboardAgentChildDisclosure.hideOneChildAgent',
          'Hide {{count}} child agent',
          { count: childAgentCount }
        )
      : translate(
          'auto.components.dashboard.DashboardAgentChildDisclosure.hideManyChildAgents',
          'Hide {{count}} child agents',
          { count: childAgentCount }
        )
    : childAgentCount === 1
      ? translate(
          'auto.components.dashboard.DashboardAgentChildDisclosure.showOneChildAgent',
          'Show {{count}} child agent',
          { count: childAgentCount }
        )
      : translate(
          'auto.components.dashboard.DashboardAgentChildDisclosure.showManyChildAgents',
          'Show {{count}} child agents',
          { count: childAgentCount }
        )

  // Why: the chevron owns child disclosure; leaf spacers keep the leading
  // state-dot column aligned across the card.
  return (
    <button
      type="button"
      onClick={handleToggleChildren}
      onMouseDown={stopMouseDown}
      onKeyDown={stopKeyDown}
      className="-ml-0.5 inline-flex size-4 shrink-0 items-center justify-center rounded-sm border border-sidebar-border/80 bg-sidebar text-foreground/80 shadow-xs hover:bg-sidebar-accent hover:text-foreground"
      aria-label={disclosureLabel}
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
