import React, { useCallback } from 'react'
import { ChevronDown, Send, X } from 'lucide-react'
import { translate } from '@/i18n/i18n'
import { cn } from '@/lib/utils'

type DashboardAgentRowTrailingControlsProps = {
  paneKey: string
  relativeTimestamp: string | null
  expanded: boolean
  hideExpand: boolean
  sendTargetStatus?: 'eligible' | 'disabled' | 'sending'
  onDismiss: (paneKey: string) => void
  onToggleExpanded: () => void
  onSendTargetClick?: (paneKey: string) => void
}

export function DashboardAgentRowTrailingControls({
  paneKey,
  relativeTimestamp,
  expanded,
  hideExpand,
  sendTargetStatus,
  onDismiss,
  onToggleExpanded,
  onSendTargetClick
}: DashboardAgentRowTrailingControlsProps): React.JSX.Element {
  // Why: stop propagation so clicking nested row controls does not also
  // activate the agent row or parent worktree card.
  const stopMouseDown = useCallback((event: React.MouseEvent) => {
    event.stopPropagation()
  }, [])
  const stopKeyDown = useCallback((event: React.KeyboardEvent) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.stopPropagation()
    }
  }, [])
  const handleDismiss = useCallback(
    (event: React.MouseEvent) => {
      event.stopPropagation()
      onDismiss(paneKey)
    },
    [onDismiss, paneKey]
  )
  const handleToggleExpand = useCallback(
    (event: React.MouseEvent<HTMLButtonElement>) => {
      event.preventDefault()
      event.stopPropagation()
      onToggleExpanded()
    },
    [onToggleExpanded]
  )
  const handleInlineSendTargetClick = useCallback(
    (event: React.MouseEvent<HTMLButtonElement>) => {
      event.preventDefault()
      event.stopPropagation()
      if (sendTargetStatus === 'eligible') {
        onSendTargetClick?.(paneKey)
      }
    },
    [onSendTargetClick, paneKey, sendTargetStatus]
  )

  return (
    <span className="relative ml-auto flex h-3.5 w-12 shrink-0 items-center justify-end">
      {(sendTargetStatus === 'eligible' || sendTargetStatus === 'sending') && (
        <button
          type="button"
          onClick={handleInlineSendTargetClick}
          onMouseDown={stopMouseDown}
          onKeyDown={stopKeyDown}
          disabled={sendTargetStatus === 'sending'}
          className={cn(
            'worktree-agent-send-target-button absolute right-0 top-1/2 z-10 inline-flex h-5 -translate-y-1/2 items-center gap-1 rounded-md border px-1.5 text-[10px] font-medium leading-none transition-[background-color,border-color,color,opacity]',
            sendTargetStatus === 'sending' && 'cursor-progress opacity-75'
          )}
          aria-label={translate(
            'auto.components.dashboard.DashboardAgentRow.0272969e28',
            'Send to this agent'
          )}
          title={translate(
            'auto.components.dashboard.DashboardAgentRow.0272969e28',
            'Send to this agent'
          )}
        >
          <Send className="size-3" />
          <span>{translate('auto.components.dashboard.DashboardAgentRow.912e136cd9', 'Send')}</span>
        </button>
      )}
      {/* Why: timestamp and dismiss-X share one slot. On no-hover devices the X
          is visible by default, so the timestamp must yield there too. */}
      {!sendTargetStatus && relativeTimestamp !== null && (
        <span className="relative grid grid-cols-1 grid-rows-1 shrink-0 items-center justify-items-end">
          <span
            className={cn(
              '[grid-area:1/1] pointer-events-none text-[10px] leading-none text-muted-foreground/60',
              'transition-opacity duration-150',
              'group-hover/agent-row:opacity-0 [@media(hover:none)]:opacity-0'
            )}
            aria-hidden
          >
            {relativeTimestamp}
          </span>
          <button
            type="button"
            onClick={handleDismiss}
            onMouseDown={stopMouseDown}
            onKeyDown={stopKeyDown}
            className={cn(
              '[grid-area:1/1] inline-flex items-center justify-center text-muted-foreground/70 hover:text-foreground',
              'can-hover:opacity-0 transition-opacity duration-150',
              'group-hover/agent-row:opacity-100 focus-visible:opacity-100'
            )}
            aria-label={translate(
              'auto.components.dashboard.DashboardAgentRow.b06e13fcf7',
              'Dismiss agent'
            )}
            title={translate('auto.components.dashboard.DashboardAgentRow.5ae84475cc', 'Dismiss')}
          >
            <X className="size-3.5" />
          </button>
        </span>
      )}
      {!sendTargetStatus && relativeTimestamp === null && (
        <button
          type="button"
          onClick={handleDismiss}
          onMouseDown={stopMouseDown}
          onKeyDown={stopKeyDown}
          className={cn(
            'inline-flex shrink-0 items-center justify-center text-muted-foreground/70 hover:text-foreground',
            'can-hover:opacity-0 transition-opacity duration-150',
            'group-hover/agent-row:opacity-100 focus-visible:opacity-100'
          )}
          aria-label={translate(
            'auto.components.dashboard.DashboardAgentRow.b06e13fcf7',
            'Dismiss agent'
          )}
          title={translate('auto.components.dashboard.DashboardAgentRow.5ae84475cc', 'Dismiss')}
        >
          <X className="size-3.5" />
        </button>
      )}
      {!hideExpand && (
        <button
          type="button"
          onClick={handleToggleExpand}
          onMouseDown={stopMouseDown}
          onKeyDown={stopKeyDown}
          className="inline-flex shrink-0 items-center justify-center text-muted-foreground/60 hover:text-foreground"
          aria-label={
            expanded
              ? translate(
                  'auto.components.dashboard.DashboardAgentRow.a41fb5376e',
                  'Collapse details'
                )
              : translate(
                  'auto.components.dashboard.DashboardAgentRow.a743da52ff',
                  'Expand details'
                )
          }
          aria-expanded={expanded}
        >
          <ChevronDown
            className={cn('size-3.5 transition-transform duration-150', expanded && 'rotate-180')}
          />
        </button>
      )}
    </span>
  )
}
