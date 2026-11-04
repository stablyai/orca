import React from 'react'
import { ChevronDown, Eye, EyeOff, ExternalLink, Trash2, type LucideIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'
import type { WorkspaceCleanupCandidate } from '../../../../shared/workspace-cleanup/workspace-cleanup'
import { WorkspaceCleanupForgetLocallyButton } from './workspace-cleanup-forget-locally-button'

// Pull the chevron's glyph, not its button, onto the right gutter shared with the header.
const CHEVRON_INK_ALIGN = '-mr-2'

type CandidateRowActionsProps = {
  candidate: WorkspaceCleanupCandidate
  identity: string
  accessibleName: string
  expanded: boolean
  hasExpandableDetails: boolean
  ignored: boolean
  selectable: boolean
  onIgnore: (candidate: WorkspaceCleanupCandidate) => void
  onRestore: (candidate: WorkspaceCleanupCandidate) => void
  onRemove: (candidate: WorkspaceCleanupCandidate) => void
  onForgetLocally?: (candidate: WorkspaceCleanupCandidate) => void
  onToggleExpanded: (identity: string) => void
  onView: (candidate: WorkspaceCleanupCandidate) => void
  /** Rendered between the hover actions and the chevron so it stays readable while actions show. */
  metrics: React.ReactNode
}

export function CandidateRowActions({
  candidate,
  identity,
  accessibleName,
  expanded,
  hasExpandableDetails,
  ignored,
  selectable,
  onIgnore,
  onRestore,
  onRemove,
  onForgetLocally,
  onToggleExpanded,
  onView,
  metrics
}: CandidateRowActionsProps): React.JSX.Element {
  const expandLabel = expanded
    ? translate(
        'auto.components.workspace.cleanup.candidateRow.collapseDetails',
        'Collapse details'
      )
    : translate('auto.components.workspace.cleanup.candidateRow.expandDetails', 'Expand details')

  return (
    <div className="flex h-6 shrink-0 items-center gap-3">
      {/* Secondary actions surface on row hover or keyboard focus; touch screens always show them. */}
      <div className="flex items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100 [@media(hover:none)]:opacity-100">
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
        {!ignored ? (
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
        ) : (
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
      {metrics}
      {hasExpandableDetails ? (
        <RowIconAction
          tooltip={expandLabel}
          ariaLabel={expandLabel}
          ariaExpanded={expanded}
          className={CHEVRON_INK_ALIGN}
          onClick={() => onToggleExpanded(identity)}
        >
          <ChevronDown className={cn('size-3.5 transition-transform', expanded && 'rotate-180')} />
        </RowIconAction>
      ) : (
        <ActionSlotPlaceholder className={CHEVRON_INK_ALIGN} />
      )}
    </div>
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
function ActionSlotPlaceholder({ className }: { className?: string }): React.JSX.Element {
  return <span className={cn('size-6 shrink-0', className)} aria-hidden="true" />
}
