import type React from 'react'
import {
  ChevronDown,
  LocateFixed,
  MessageSquarePlus,
  MoreHorizontal,
  PanelTopOpen,
  Play
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { cn } from '@/lib/utils'
import type { AiVaultSession } from '../../../../shared/ai-vault-types'
import { agentLabel } from './ai-vault-session-filters'
import { translate } from '@/i18n/i18n'
import { SessionActionMenuItems } from './AiVaultSessionActionMenuItems'
import {
  aiVaultWorktreeJumpTooltip,
  type AiVaultSessionWorktreeInfo
} from './ai-vault-session-worktree'

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
  resumeLabel,
  worktreeInfo,
  onToggleDetails,
  onJumpToOriginalPane,
  showJumpToWorktree,
  onJumpToWorktree,
  onResume,
  onContinueInNewSession,
  onCopyResume,
  onCopyId,
  onCopyPath,
  onOpenLog,
  onRevealLog,
  onOpenCwd
}: {
  session: AiVaultSession
  detailsExpanded: boolean
  detailsId: string
  detailsTooltip: string
  resumeDisabled: boolean
  resumeLabel: string
  worktreeInfo: AiVaultSessionWorktreeInfo | null
  onToggleDetails: () => void
  onJumpToOriginalPane?: () => void
  showJumpToWorktree: boolean
  onJumpToWorktree?: () => void
  onResume: () => void
  onContinueInNewSession?: () => void
  onCopyResume?: () => void
  onCopyId: () => void
  onCopyPath: () => void
  onOpenLog?: () => void
  onRevealLog?: () => void
  onOpenCwd?: () => void
}) {
  const jumpToWorktreeTooltip = aiVaultWorktreeJumpTooltip(worktreeInfo)

  return (
    <div
      className="flex shrink-0 items-center gap-1"
      data-ai-vault-session-actions="true"
      onPointerDown={(event) => event.stopPropagation()}
      onDoubleClick={(event) => event.stopPropagation()}
    >
      <div className={HOVER_ACTION_GROUP_CLASS}>
        {onJumpToOriginalPane ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                aria-label={translate(
                  'auto.components.right.sidebar.AiVaultSessionRow.jumpToOriginalPane',
                  'Jump to Original Pane'
                )}
                draggable={false}
                onClick={(event) => {
                  event.stopPropagation()
                  onJumpToOriginalPane()
                }}
                data-testid="ai-vault-session-jump-original-pane"
                className="can-hover:pointer-events-none group-hover/session-row:pointer-events-auto group-focus-within/session-row:pointer-events-auto focus-visible:pointer-events-auto"
              >
                <LocateFixed className="size-3.5" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="top" sideOffset={4}>
              {translate(
                'auto.components.right.sidebar.AiVaultSessionRow.jumpToOriginalPane',
                'Jump to Original Pane'
              )}
            </TooltipContent>
          </Tooltip>
        ) : null}
        {showJumpToWorktree ? (
          <Tooltip>
            <WorktreeJumpTooltipTrigger
              disabled={!onJumpToWorktree}
              ariaLabel={jumpToWorktreeTooltip}
              onJumpToWorktree={onJumpToWorktree}
            />
            <TooltipContent side="top" sideOffset={4}>
              {jumpToWorktreeTooltip}
            </TooltipContent>
          </Tooltip>
        ) : null}
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              aria-label={resumeLabel}
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
            {resumeLabel}
          </TooltipContent>
        </Tooltip>
        {onContinueInNewSession ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                aria-label={translate(
                  'components.agentSessionContinuation.continueInNewSession',
                  'Continue in New Session…'
                )}
                draggable={false}
                onClick={(event) => {
                  event.stopPropagation()
                  onContinueInNewSession()
                }}
                data-testid="ai-vault-session-continue-in-new-session"
                className="can-hover:pointer-events-none group-hover/session-row:pointer-events-auto group-focus-within/session-row:pointer-events-auto focus-visible:pointer-events-auto"
              >
                <MessageSquarePlus className="size-3.5" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="top" sideOffset={4}>
              {translate(
                'components.agentSessionContinuation.continueInNewSession',
                'Continue in New Session…'
              )}
            </TooltipContent>
          </Tooltip>
        ) : null}
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
            resumeLabel={resumeLabel}
            onResume={onResume}
            onContinueInNewSession={onContinueInNewSession}
            onJumpToOriginalPane={onJumpToOriginalPane}
            showJumpToWorktree={showJumpToWorktree}
            onJumpToWorktree={onJumpToWorktree}
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

function WorktreeJumpTooltipTrigger({
  disabled,
  ariaLabel,
  onJumpToWorktree
}: {
  disabled: boolean
  ariaLabel: string
  onJumpToWorktree?: () => void
}): React.JSX.Element {
  const button = (
    <Button
      type="button"
      variant="ghost"
      size="icon-xs"
      aria-label={ariaLabel}
      disabled={disabled}
      draggable={false}
      onClick={(event) => {
        event.stopPropagation()
        onJumpToWorktree?.()
      }}
      data-testid="ai-vault-session-jump-worktree"
      className={cn(
        !disabled &&
          'can-hover:pointer-events-none group-hover/session-row:pointer-events-auto group-focus-within/session-row:pointer-events-auto focus-visible:pointer-events-auto'
      )}
    >
      <PanelTopOpen className="size-3.5" />
    </Button>
  )

  if (!disabled) {
    return <TooltipTrigger asChild>{button}</TooltipTrigger>
  }

  return (
    <TooltipTrigger asChild>
      <span
        className="inline-flex can-hover:pointer-events-none group-hover/session-row:pointer-events-auto group-focus-within/session-row:pointer-events-auto"
        onClick={(event) => event.stopPropagation()}
      >
        {button}
      </span>
    </TooltipTrigger>
  )
}
