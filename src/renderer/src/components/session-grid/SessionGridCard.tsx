import React, { useCallback, useRef } from 'react'
import { Eye, EyeOff, GitBranch, Maximize2, X, GripVertical } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { AgentStateDot } from '@/components/AgentStateDot'
import {
  TerminalTabAttentionBadgeGlyph,
  terminalTabAttentionBadgeLabel
} from '@/components/tab-bar/terminal-tab-attention-badge-glyph'
import { AgentTerminalPreview } from '../dashboard-popout/AgentTerminalPreview'
import { DashboardHostBadge } from '../dashboard-popout/DashboardHostBadge'
import { PreviewStartingNotice } from '../dashboard-popout/preview-terminal-phase-overlay'
import { useSessionGridCardTerminalInput } from './session-grid-card-terminal-input'
import { useSessionGridCardRestore } from './use-session-grid-card-restore'
import { useAppStore } from '@/store'
import { SessionGridCardIdentityIcon, useSessionGridCardAgent } from './session-grid-card-agent'
import {
  SESSION_GRID_SCROLL_CONTAINER_ID,
  SESSION_GRID_WHEEL_EVENT,
  type SessionGridWheelHandoffDetail
} from './use-session-grid-scroll'
import { isDiscreteWheelEvent } from './session-grid-wheel-gesture'
import { sessionGridVisibilityActionLabel } from './session-grid-visibility-labels'
import {
  sessionGridBranchMeta,
  sessionGridWorkspaceIdentity
} from './session-grid-worktree-catalog'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'
import type { SessionGridItem } from '../../../../shared/session-grid-types'

type SessionGridCardProps = {
  item: SessionGridItem
  isActive: boolean
  /** Gate for the live terminal; the header and chrome render regardless. */
  previewMounted?: boolean
  isDragging?: boolean
  dragHandleProps?: React.HTMLAttributes<HTMLDivElement>
  onFocus: () => void
  onMaximize: () => void
  onClose: () => void
  onToggleHidden: () => void
}

export function SessionGridCard({
  item,
  isActive,
  previewMounted = true,
  isDragging,
  dragHandleProps,
  onFocus,
  onMaximize,
  onClose,
  onToggleHidden
}: SessionGridCardProps): React.JSX.Element {
  const focusTerminalRef = useRef<(() => void) | null>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  const viewportRef = useRef<HTMLDivElement>(null)
  // Why: marking the card active must also hand it the keyboard — clicking the
  // header or a badge never reaches xterm's own mousedown handler, so the focus
  // ring and the real focus would point at different cards.
  const handleClick = useCallback(() => {
    onFocus()
    focusTerminalRef.current?.()
  }, [onFocus])
  // Why only the card itself or its terminal, and not any descendant: the header buttons stop
  // propagation on click, so clicking one never selects the card — focus must not either. And
  // selecting now acknowledges the turn across five surfaces, so a Tab sweep over a grid of
  // nine would silence all nine on the way past: the "nine at once" failure the viewport-ack
  // variant was rejected for, arriving by keyboard instead. Tab landing on a header button
  // still stays there, or the button could never be activated.
  const handleFocusCapture = useCallback(
    (e: React.FocusEvent<HTMLDivElement>) => {
      if (e.target !== e.currentTarget && !viewportRef.current?.contains(e.target)) {
        return
      }
      onFocus()
      focusTerminalRef.current?.()
    },
    [onFocus]
  )
  // Why a CustomEvent: the grid takes the wheel in capture phase, so a re-dispatched native event would land back in the preview.
  const handleWheelOverflow = useCallback((event: WheelEvent) => {
    event.preventDefault()
    rootRef.current?.closest<HTMLElement>(`#${SESSION_GRID_SCROLL_CONTAINER_ID}`)?.dispatchEvent(
      new CustomEvent<SessionGridWheelHandoffDetail>(SESSION_GRID_WHEEL_EVENT, {
        bubbles: true,
        detail: {
          deltaY: event.deltaY,
          discrete: isDiscreteWheelEvent(event)
        }
      })
    )
  }, [])
  const sessionsGridZoom = useAppStore((s) => s.sessionsGridZoom)
  const sessionsGridWheelTarget = useAppStore((s) => s.sessionsGridWheelTarget)
  const settings = useAppStore((s) => s.settings)
  const terminalInput = useSessionGridCardTerminalInput(item)
  const { restoring, failed, timedOut, restore, onPtyGone } = useSessionGridCardRestore(item)
  const agent = useSessionGridCardAgent(item)
  const baseFontSize = settings?.terminalFontSize ?? 14
  const effectiveFontSize = Math.max(8, Math.min(32, Math.round(baseFontSize * sessionsGridZoom)))
  const handleHeaderDoubleClick = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation()
      onMaximize()
    },
    [onMaximize]
  )

  const handleClose = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation()
      onClose()
    },
    [onClose]
  )

  const handleMaximize = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation()
      onMaximize()
    },
    [onMaximize]
  )

  const handleToggleHidden = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation()
      onToggleHidden()
    },
    [onToggleHidden]
  )
  const visibilityLabel = sessionGridVisibilityActionLabel(item.isHiddenFromGrid)
  const branchMeta = sessionGridBranchMeta(item)

  return (
    <div
      ref={rootRef}
      data-testid="session-grid-card"
      data-tab-id={item.tabId}
      data-hidden-from-grid={item.isHiddenFromGrid ? 'true' : undefined}
      onClick={handleClick}
      onFocusCapture={handleFocusCapture}
      className={cn(
        'group relative flex h-full min-h-0 w-full flex-col overflow-hidden rounded-xl border bg-card/95 transition-all duration-150',
        isActive
          ? 'border-ring/80 ring-2 ring-ring/40 shadow-xs'
          : 'border-border hover:border-border/80',
        isDragging && 'opacity-30 border-dashed border-ring/50 pointer-events-none',
        // Only reachable while the toolbar's reveal mode is on: dimmed so it reads as
        // "shown for management", not as part of the working set.
        item.isHiddenFromGrid && !isDragging && 'opacity-60 border-dashed'
      )}
    >
      <div
        onDoubleClick={handleHeaderDoubleClick}
        className={cn(
          'flex h-8 shrink-0 items-center justify-between border-b border-border bg-muted/40 px-2 text-xs select-none',
          dragHandleProps ? 'cursor-grab active:cursor-grabbing' : 'cursor-default'
        )}
        {...dragHandleProps}
      >
        <div className="flex min-w-0 items-center gap-1.5 overflow-hidden pointer-events-none">
          <GripVertical className="size-3.5 shrink-0 text-muted-foreground/35 group-hover:text-muted-foreground/75 transition-colors" />

          {/* Project › workspace › session, spelled the way the scope picker and launcher
              spell it: the workspace identity first, then what runs inside it as glyph + name.
              The branch is an attribute of the workspace, so it only shows when it adds a fact. */}
          <span
            className="truncate max-w-[220px]"
            title={`${sessionGridWorkspaceIdentity(item.repoName, item.worktreeName)} · ${item.title}`}
          >
            {item.worktreeName !== item.repoName ? (
              <span className="text-muted-foreground">{item.repoName} / </span>
            ) : null}
            <span className="font-medium text-foreground/90">{item.worktreeName}</span>
          </span>

          {branchMeta && (
            <span
              className="inline-flex items-center gap-1 rounded bg-muted/60 px-1.5 py-0.5 text-[10px] text-muted-foreground max-w-[140px] truncate"
              title={branchMeta}
            >
              <GitBranch className="size-2.5 shrink-0" />
              <span className="truncate">{branchMeta}</span>
            </span>
          )}

          <span className="flex min-w-0 items-center gap-1 text-muted-foreground">
            <SessionGridCardIdentityIcon agent={agent} shell={item.shellOverride} />
            <span
              className="truncate max-w-[180px] text-xs"
              data-testid="session-grid-card-session"
            >
              {item.title}
            </span>
          </span>

          {item.contextPercent !== undefined && (
            <span
              className={cn(
                'rounded px-1 text-[10px] font-mono font-medium',
                item.contextPercent > 80
                  ? 'bg-destructive/20 text-destructive'
                  : 'bg-muted text-muted-foreground'
              )}
            >
              {item.contextPercent}%
            </span>
          )}

          {/* Auto-hides on a local host; `pointer-events-auto` because the group around it
              is not, and the badge's tooltip is the only place the host is named. */}
          <DashboardHostBadge
            hostKind={item.hostKind}
            executionHostId={item.executionHostId}
            hostLabel={item.hostLabel}
            className="pointer-events-auto"
          />

          <div className="shrink-0" data-attention-badge={item.attentionBadge ?? 'none'}>
            {item.attentionBadge ? (
              <>
                <TerminalTabAttentionBadgeGlyph badge={item.attentionBadge} />
                {/* Why sr-only and not a tooltip: this whole group is pointer-events-none
                    so the header stays draggable, and the bell has no glyph label of its own. */}
                <span className="sr-only">
                  {terminalTabAttentionBadgeLabel(item.attentionBadge)}
                </span>
              </>
            ) : (
              <AgentStateDot state={item.dotState} size="sm" />
            )}
          </div>
        </div>

        <div className="flex items-center gap-0.5 shrink-0 pl-2 opacity-80 group-hover:opacity-100">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="size-6 text-muted-foreground hover:text-foreground"
                data-testid="session-grid-card-hide"
                onPointerDown={(e) => e.stopPropagation()}
                onClick={handleToggleHidden}
                aria-label={visibilityLabel}
              >
                {item.isHiddenFromGrid ? (
                  <Eye className="size-3.5" />
                ) : (
                  <EyeOff className="size-3.5" />
                )}
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom" sideOffset={4}>
              {visibilityLabel}
            </TooltipContent>
          </Tooltip>

          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="size-6 text-muted-foreground hover:text-foreground"
                onPointerDown={(e) => e.stopPropagation()}
                onClick={handleMaximize}
                aria-label={translate(
                  'auto.components.session.grid.SessionGridCard.dcbfba372d',
                  'Maximize to tabs view'
                )}
              >
                <Maximize2 className="size-3.5" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom" sideOffset={4}>
              {translate(
                'auto.components.session.grid.SessionGridCard.dcbfba372d',
                'Maximize to tabs view'
              )}
            </TooltipContent>
          </Tooltip>

          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="size-6 text-muted-foreground hover:text-destructive hover:bg-destructive/10"
                onPointerDown={(e) => e.stopPropagation()}
                onClick={handleClose}
                aria-label={translate(
                  'auto.components.session.grid.SessionGridCard.3cb420110d',
                  'Close session'
                )}
              >
                <X className="size-3.5" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom" sideOffset={4}>
              {translate(
                'auto.components.session.grid.SessionGridCard.3cb420110d',
                'Close session'
              )}
            </TooltipContent>
          </Tooltip>
        </div>
      </div>

      <div
        ref={viewportRef}
        className="relative flex-1 min-h-0 min-w-0 overflow-hidden bg-background"
      >
        {previewMounted && !restoring && (failed || !item.ptyId) ? (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 p-3 text-center">
            {/* A timeout is not a verdict on the session: it names the wait, never an exit. */}
            <p role="status" className="text-xs text-muted-foreground">
              {timedOut
                ? translate('sessionGrid.terminal.reconnectTimedOut', 'Reconnect timed out')
                : translate('sessionGrid.terminal.notConnected', 'Session not connected')}
            </p>
            <Button
              data-testid="session-grid-load-session"
              variant="outline"
              size="sm"
              onClick={(event) => {
                event.stopPropagation()
                restore()
              }}
            >
              {timedOut
                ? translate('sessionGrid.terminal.retry', 'Try again')
                : translate('sessionGrid.terminal.load', 'Load session')}
            </Button>
          </div>
        ) : item.ptyId && previewMounted && !restoring ? (
          <AgentTerminalPreview
            ptyId={item.ptyId}
            terminalInput={terminalInput}
            fontSize={effectiveFontSize}
            fitAxis="both"
            autoFocus={false}
            focusRef={focusTerminalRef}
            detachBatched
            onWheelOverflow={handleWheelOverflow}
            wheelTarget={sessionsGridWheelTarget}
            onPtyGone={onPtyGone}
            className="h-full w-full"
          />
        ) : (
          <PreviewStartingNotice />
        )}
      </div>
    </div>
  )
}
