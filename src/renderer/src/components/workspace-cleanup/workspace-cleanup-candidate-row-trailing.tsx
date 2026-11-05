import React from 'react'
import { ChevronDown, Eye, EyeOff, ExternalLink, Trash2, type LucideIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'
import type { WorkspaceCleanupCandidate } from '../../../../shared/workspace-cleanup/workspace-cleanup'
import { WorkspaceCleanupForgetLocallyButton } from './workspace-cleanup-forget-locally-button'
import { getWorkspaceCleanupCandidateAccessibleName } from './workspace-cleanup-host-label'

type CandidateRowTrailingProps = {
  candidate: WorkspaceCleanupCandidate
  identity: string
  expanded: boolean
  hasExpandableDetails: boolean
  /** Queueable and not already deleting; gates Remove. */
  selectable: boolean
  lastActivityLabel: string
  /** Joined from the workspace-space scan; null when this row was not measured. */
  sizeLabel: string | null
  /** False until any row has a measured size. */
  showSizeColumn: boolean
  onIgnore: (candidate: WorkspaceCleanupCandidate) => void
  onRestore: (candidate: WorkspaceCleanupCandidate) => void
  onRemove: (candidate: WorkspaceCleanupCandidate) => void
  onForgetLocally?: (candidate: WorkspaceCleanupCandidate) => void
  onToggleExpanded: (identity: string) => void
  onView: (candidate: WorkspaceCleanupCandidate) => void
}

/** Hover actions, then fixed time/size columns, then the chevron, so the numbers never move. */
export function CandidateRowTrailing({
  candidate,
  identity,
  expanded,
  hasExpandableDetails,
  selectable,
  lastActivityLabel,
  sizeLabel,
  showSizeColumn,
  onIgnore,
  onRestore,
  onRemove,
  onForgetLocally,
  onToggleExpanded,
  onView
}: CandidateRowTrailingProps): React.JSX.Element {
  const accessibleName = getWorkspaceCleanupCandidateAccessibleName(candidate)
  const expandLabel = expanded
    ? translate(
        'auto.components.workspace.cleanup.candidateRow.collapseDetails',
        'Collapse details'
      )
    : translate('auto.components.workspace.cleanup.candidateRow.expandDetails', 'Expand details')

  return (
    <div className="flex h-6 shrink-0 items-center gap-3">
      {/* Secondary actions surface on row hover or keyboard focus; touch screens always show them. */}
      <div className="flex items-center gap-0.5 opacity-0 transition-opacity group-hover/row:opacity-100 [[class~='group/row']:has(:focus-visible)_&]:opacity-100 [@media(hover:none)]:opacity-100">
        <RowIconAction
          icon={ExternalLink}
          tooltip={translate('components.workspace.cleanup.browse.openWorkspace', 'Open workspace')}
          ariaLabel={translate(
            'components.workspace.cleanup.browse.openWorkspaceNamed',
            'Open {{value0}}',
            { value0: accessibleName }
          )}
          onClick={() => onView(candidate)}
        />
        {candidate.blockers.includes('dismissed') ? (
          <RowIconAction
            icon={Eye}
            tooltip={translate('components.workspace.cleanup.browse.stopIgnoring', 'Stop ignoring')}
            ariaLabel={translate(
              'components.workspace.cleanup.browse.stopIgnoringNamed',
              'Stop ignoring {{value0}}',
              { value0: accessibleName }
            )}
            onClick={() => onRestore(candidate)}
          />
        ) : (
          <RowIconAction
            icon={EyeOff}
            tooltip={translate(
              'components.workspace.cleanup.browse.ignoreTooltip',
              'Ignore: skip in bulk delete'
            )}
            ariaLabel={translate(
              'auto.components.workspace.cleanup.WorkspaceCleanupDialog.a9957007eb',
              'Ignore {{value0}}',
              { value0: accessibleName }
            )}
            onClick={() => onIgnore(candidate)}
          />
        )}
        {selectable ? (
          <RowIconAction
            icon={Trash2}
            tooltip={translate(
              'auto.components.workspace.cleanup.WorkspaceCleanupDialog.9cc26c019d',
              'Remove'
            )}
            ariaLabel={translate(
              'auto.components.workspace.cleanup.WorkspaceCleanupDialog.3828408538',
              'Remove {{value0}}',
              { value0: accessibleName }
            )}
            className="text-destructive hover:text-destructive"
            onClick={() => onRemove(candidate)}
          />
        ) : candidate.blockers.includes('ssh-disconnected') && onForgetLocally ? (
          <WorkspaceCleanupForgetLocallyButton candidate={candidate} onForget={onForgetLocally} />
        ) : (
          <ActionSlotPlaceholder />
        )}
      </div>
      <div className="flex items-center gap-4 text-xs tabular-nums text-muted-foreground">
        <RowMetric
          label={translate(
            'components.workspace.cleanup.browse.lastActive',
            'Last active {{value0}}',
            { value0: lastActivityLabel }
          )}
          value={lastActivityLabel}
        />
        {showSizeColumn ? (
          <RowMetric
            label={translate(
              'components.workspace.cleanup.browse.sizeOnDisk',
              'Size on disk: {{value0}}',
              {
                value0:
                  sizeLabel ??
                  translate('components.workspace.cleanup.browse.notMeasured', 'Not measured')
              }
            )}
            value={sizeLabel ?? '—'}
          />
        ) : null}
      </div>
      {hasExpandableDetails ? (
        <RowIconAction
          tooltip={expandLabel}
          ariaLabel={expandLabel}
          ariaExpanded={expanded}
          onClick={() => onToggleExpanded(identity)}
        >
          <ChevronDown className={cn('size-3.5 transition-transform', expanded && 'rotate-180')} />
        </RowIconAction>
      ) : (
        <ActionSlotPlaceholder />
      )}
    </div>
  )
}

// Self-describing values ("2h ago", "4.8 GB") right-aligned so rows compare down the column.
function RowMetric({ label, value }: { label: string; value: string }): React.JSX.Element {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="w-16 truncate text-right" aria-label={label}>
          {value}
        </span>
      </TooltipTrigger>
      <TooltipContent side="top" sideOffset={4}>
        {label}
      </TooltipContent>
    </Tooltip>
  )
}

function RowIconAction({
  icon: Icon,
  children,
  tooltip,
  ariaLabel,
  ariaExpanded,
  className,
  onClick
}: {
  icon?: LucideIcon
  children?: React.ReactNode
  tooltip: string
  ariaLabel: string
  ariaExpanded?: boolean
  className?: string
  onClick: () => void
}): React.JSX.Element {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label={ariaLabel}
          aria-expanded={ariaExpanded}
          className={className}
          onClick={onClick}
        >
          {Icon ? <Icon className="size-3.5" /> : children}
        </Button>
      </TooltipTrigger>
      <TooltipContent side="top" sideOffset={4}>
        {tooltip}
      </TooltipContent>
    </Tooltip>
  )
}

// Reserve icon-xs slots so metric and action columns line up across rows with different actions.
function ActionSlotPlaceholder(): React.JSX.Element {
  return <span className="size-6 shrink-0" aria-hidden="true" />
}
