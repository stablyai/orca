import React, { useCallback } from 'react'
import { ChevronDown, Send, Square, X } from 'lucide-react'
import { translate } from '@/i18n/i18n'
import { cn } from '@/lib/utils'

type DashboardAgentRowTrailingControlsProps = {
  paneKey: string
  relativeTimestamp: string | null
  expanded: boolean
  hideExpand: boolean
  /** Subagent child rows have no store entry of their own to dismiss —
   *  offering the X would be a silent no-op. */
  hideDismiss?: boolean
  sendTargetStatus?: 'eligible' | 'disabled' | 'sending'
  onDismiss: (paneKey: string) => void
  /** Closes the agent's whole terminal tab (splits included) after confirmation.
   *  Offered only for live rows — retained/dead rows get the dismiss X alone. */
  onCloseSession?: (paneKey: string) => void
  onToggleExpanded: () => void
  onSendTargetClick?: (paneKey: string) => void
}

export function DashboardAgentRowTrailingControls({
  paneKey,
  relativeTimestamp,
  expanded,
  hideExpand,
  hideDismiss = false,
  sendTargetStatus,
  onDismiss,
  onCloseSession,
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
  const handleCloseSession = useCallback(
    (event: React.MouseEvent) => {
      event.preventDefault()
      event.stopPropagation()
      onCloseSession?.(paneKey)
    },
    [onCloseSession, paneKey]
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

  // Why: timestamp/dismiss hover reveal lives on each button (not a wrapper)
  // so keyboard focus reveals the focused control itself.
  const hoverRevealClasses =
    'can-hover:opacity-0 transition-opacity duration-150 group-hover/agent-row:opacity-100 focus-visible:opacity-100'

  // Why: Square reads as "stop the session" — deliberately distinct from the
  // dismiss X, which only hides the row.
  const closeSessionButton = onCloseSession ? (
    <button
      type="button"
      onClick={handleCloseSession}
      onMouseDown={stopMouseDown}
      onKeyDown={stopKeyDown}
      className={cn(
        'inline-flex items-center justify-center text-muted-foreground/70 hover:text-foreground',
        hoverRevealClasses
      )}
      aria-label={translate(
        'auto.components.dashboard.DashboardAgentRow.271b256627',
        'Close agent session'
      )}
      title={translate('auto.components.dashboard.DashboardAgentRow.1c27be5226', 'Close session')}
    >
      <Square className="size-3" />
    </button>
  ) : null

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
      {!sendTargetStatus && hideDismiss && relativeTimestamp !== null && (
        <span
          className="pointer-events-none shrink-0 text-[10px] leading-none text-muted-foreground/60"
          aria-hidden
        >
          {relativeTimestamp}
        </span>
      )}
      {/* Why: timestamp and dismiss-X share one slot. On no-hover devices the X
          is visible by default, so the timestamp must yield there too. */}
      {!sendTargetStatus && !hideDismiss && relativeTimestamp !== null && (
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
          <span className="[grid-area:1/1] inline-flex items-center justify-end gap-1">
            {closeSessionButton}
            <button
              type="button"
              onClick={handleDismiss}
              onMouseDown={stopMouseDown}
              onKeyDown={stopKeyDown}
              className={cn(
                'inline-flex items-center justify-center text-muted-foreground/70 hover:text-foreground',
                hoverRevealClasses
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
        </span>
      )}
      {!sendTargetStatus && !hideDismiss && relativeTimestamp === null && (
        <span className="inline-flex shrink-0 items-center justify-end gap-1">
          {closeSessionButton}
          <button
            type="button"
            onClick={handleDismiss}
            onMouseDown={stopMouseDown}
            onKeyDown={stopKeyDown}
            className={cn(
              'inline-flex items-center justify-center text-muted-foreground/70 hover:text-foreground',
              hoverRevealClasses
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
