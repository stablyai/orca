import { Crosshair } from 'lucide-react'
import React from 'react'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/class-names'
import { requestScrollToCurrentWorkspaceReveal } from '@/lib/workspace/navigation/scroll-to-current-workspace-status'
import { useTranslate } from '@/i18n/use-translate'
import { useSidebarRevealUnavailableReason } from '../../sidebar-reveal-target-state'
import type { SidebarRevealNoneReason } from '../../../../../../shared/sidebar-list/sidebar-reveal-target'

function useReasonText(reason: SidebarRevealNoneReason | null): string | null {
  const t = useTranslate()
  switch (reason) {
    case null:
      return null
    case 'no-workspace':
      return t('sidebar.revealCurrent.noWorkspace', 'Nothing is open')
    case 'full-page-view':
      return t('sidebar.revealCurrent.fullPageView', 'This page has no row in the sidebar')
    case 'archived':
      return t('sidebar.revealCurrent.archived', 'Archived workspaces aren’t listed in the sidebar')
    case 'bots-off':
      return t('sidebar.revealCurrent.botsOff', 'Bots are turned off, so this bot isn’t listed')
    case 'bot-hidden':
      return t('sidebar.revealCurrent.botHidden', 'This bot is paused and hidden by Bot options')
  }
}

/** Shows what is in front in the sidebar, in Projects or in Bots; off, with its reason, when nothing lists it. */
export function ScrollToCurrentWorkspaceToolbarButton(): React.JSX.Element {
  const t = useTranslate()
  const reasonText = useReasonText(useSidebarRevealUnavailableReason())
  const label = t('sidebar.revealCurrent.label', 'Reveal current')
  const unavailable = reasonText !== null
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        {/* aria-disabled, not disabled: it keeps focus and hover, so its tooltip can say why. */}
        <Button
          variant="ghost"
          size="icon-xs"
          type="button"
          aria-label={unavailable ? `${label}. ${reasonText}` : label}
          aria-disabled={unavailable || undefined}
          onClick={(event) => {
            if (unavailable) {
              event.preventDefault()
              return
            }
            requestScrollToCurrentWorkspaceReveal()
          }}
          className="text-muted-foreground"
          // Off reads as off: no pointer, a dimmed mark; Button's own classes stay its variant's.
          style={unavailable ? { cursor: 'default' } : undefined}
        >
          <Crosshair className={cn('size-3.5', unavailable && 'opacity-50')} />
        </Button>
      </TooltipTrigger>
      <TooltipContent side="top" sideOffset={4}>
        {unavailable ? (
          <span className="flex flex-col">
            <span>{label}</span>
            <span className="opacity-75">{reasonText}</span>
          </span>
        ) : (
          label
        )}
      </TooltipContent>
    </Tooltip>
  )
}
