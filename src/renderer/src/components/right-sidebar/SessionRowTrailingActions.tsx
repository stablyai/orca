import { useCallback, useEffect, useRef } from 'react'
import type React from 'react'
import { ChevronDown, GripVertical, MoreHorizontal, Play } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { cn } from '@/lib/utils'
import { AI_VAULT_SESSION_DRAG_END_EVENT } from '@/lib/ai-vault-session-drag'
import type { AiVaultSession } from '../../../../shared/ai-vault-types'
import { agentLabel } from './ai-vault-session-filters'
import { translate } from '@/i18n/i18n'
import { SessionActionMenuItems } from './AiVaultSessionRow'

// Why: hover-only actions live on the title row and collapse on hover-capable
// devices so the prompt keeps the full width until the row is hovered.
// Layout and animation classes for the hover-reveal group.
const HOVER_ACTION_GROUP_BASE = 'flex items-center gap-1 transition-[max-width,margin,opacity]'

// Touch devices: always visible. Hover-capable devices: collapsed until hovered.
const HOVER_ACTION_GROUP_COLLAPSED =
  'can-hover:max-w-0 can-hover:-ml-1 can-hover:overflow-hidden can-hover:opacity-0 [@media(hover:none)]:opacity-100'

// Revealed state on hover or focus-within.
const HOVER_ACTION_GROUP_REVEALED =
  'group-hover/session-row:max-w-none group-hover/session-row:ml-0 group-hover/session-row:overflow-visible group-hover/session-row:opacity-100 group-focus-within/session-row:max-w-none group-focus-within/session-row:ml-0 group-focus-within/session-row:overflow-visible group-focus-within/session-row:opacity-100'

const HOVER_ACTION_GROUP_CLASS = `${HOVER_ACTION_GROUP_BASE} ${HOVER_ACTION_GROUP_COLLAPSED} ${HOVER_ACTION_GROUP_REVEALED}`

export function SessionRowTrailingActions({
  session,
  detailsExpanded,
  detailsId,
  detailsTooltip,
  resumeDisabled,
  onToggleDetails,
  onResume,
  onCopyResume,
  onCopyId,
  onCopyPath,
  onOpenLog,
  onRevealLog,
  onOpenCwd,
  onStartResumeDrag
}: {
  session: AiVaultSession
  detailsExpanded: boolean
  detailsId: string
  detailsTooltip: string
  resumeDisabled: boolean
  onToggleDetails: () => void
  onResume: () => void
  onCopyResume: () => void
  onCopyId: () => void
  onCopyPath: () => void
  onOpenLog: () => void
  onRevealLog: () => void
  onOpenCwd?: () => void
  onStartResumeDrag: (event: React.DragEvent<HTMLButtonElement>) => void
}) {
  // Track drag state to cleanup on unmount
  const isDraggingRef = useRef(false)

  const handleDragStart = useCallback(
    (event: React.DragEvent<HTMLButtonElement>) => {
      isDraggingRef.current = true
      onStartResumeDrag(event)
    },
    [onStartResumeDrag]
  )

  const handleDragEnd = useCallback(() => {
    isDraggingRef.current = false
    window.dispatchEvent(new Event(AI_VAULT_SESSION_DRAG_END_EVENT))
  }, [])

  // Cleanup drag state on unmount if a drag was in progress
  useEffect(() => {
    return () => {
      if (isDraggingRef.current) {
        window.dispatchEvent(new Event(AI_VAULT_SESSION_DRAG_END_EVENT))
        isDraggingRef.current = false
      }
    }
  }, [])

  return (
    <div
      className="flex shrink-0 items-center gap-1"
      onPointerDown={(event) => event.stopPropagation()}
      onDoubleClick={(event) => event.stopPropagation()}
    >
      <div className={HOVER_ACTION_GROUP_CLASS}>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              aria-label={translate(
                'auto.components.right.sidebar.AiVaultSessionRow.dragToResume',
                'Drag to resume in a new tab'
              )}
              disabled={resumeDisabled}
              draggable={!resumeDisabled}
              onClick={(event) => {
                event.stopPropagation()
              }}
              onDragStart={handleDragStart}
              onDragEnd={handleDragEnd}
              data-testid="ai-vault-session-drag-handle"
              // Why: the card is for inspection. Drag-to-resume lives on a
              // quiet handle so the row does not look movable by default.
              className="cursor-grab can-hover:pointer-events-none active:cursor-grabbing group-hover/session-row:pointer-events-auto group-focus-within/session-row:pointer-events-auto focus-visible:pointer-events-auto"
            >
              <GripVertical className="size-3.5" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="top" sideOffset={4}>
            {translate(
              'auto.components.right.sidebar.AiVaultSessionRow.dragToResume',
              'Drag to resume in a new tab'
            )}
          </TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              aria-label={translate(
                'auto.components.right.sidebar.AiVaultSessionRow.resumeAgentSession',
                'Resume {{value0}} session',
                { value0: agentLabel(session.agent) }
              )}
              disabled={resumeDisabled}
              draggable={false}
              onClick={(event) => {
                event.stopPropagation()
                onResume()
              }}
              data-testid="ai-vault-session-resume"
              // Why: on touch (no hover) these controls stay visible and
              // tappable; on hover-capable devices the session row gates both
              // visibility and hit targets until it is hovered.
              className="can-hover:pointer-events-none group-hover/session-row:pointer-events-auto group-focus-within/session-row:pointer-events-auto focus-visible:pointer-events-auto"
            >
              <Play className="size-3.5" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="top" sideOffset={4}>
            {translate(
              'auto.components.right.sidebar.AiVaultSessionRow.resumeInNewTab',
              'Resume in New Tab'
            )}
          </TooltipContent>
        </Tooltip>
      </div>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            aria-label={translate(
              'auto.components.right.sidebar.AiVaultSessionRow.toggleSessionDetails',
              '{{value0}} session details',
              { value0: agentLabel(session.agent) }
            )}
            aria-expanded={detailsExpanded}
            aria-controls={detailsId}
            draggable={false}
            onClick={(event) => {
              event.stopPropagation()
              onToggleDetails()
            }}
            data-testid="ai-vault-session-toggle-details"
          >
            <ChevronDown
              className={cn('size-3.5 transition-transform', detailsExpanded && 'rotate-180')}
            />
          </Button>
        </TooltipTrigger>
        <TooltipContent side="top" sideOffset={4}>
          {detailsTooltip}
        </TooltipContent>
      </Tooltip>
      <DropdownMenu>
        <Tooltip>
          <TooltipTrigger asChild>
            <DropdownMenuTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                aria-label={translate(
                  'auto.components.right.sidebar.AiVaultSessionRow.moreSessionActions',
                  'More Session Actions'
                )}
                draggable={false}
                data-testid="ai-vault-session-more-actions"
                onClick={(event) => event.stopPropagation()}
              >
                <MoreHorizontal className="size-3.5" />
              </Button>
            </DropdownMenuTrigger>
          </TooltipTrigger>
          <TooltipContent side="top" sideOffset={4}>
            {translate(
              'auto.components.right.sidebar.AiVaultSessionRow.moreActions',
              'More Actions'
            )}
          </TooltipContent>
        </Tooltip>
        <DropdownMenuContent align="end">
          <SessionActionMenuItems
            resumeDisabled={resumeDisabled}
            onResume={onResume}
            onCopyResume={onCopyResume}
            onCopyId={onCopyId}
            onCopyPath={onCopyPath}
            onOpenLog={onOpenLog}
            onRevealLog={onRevealLog}
            onOpenCwd={onOpenCwd}
          />
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
}
