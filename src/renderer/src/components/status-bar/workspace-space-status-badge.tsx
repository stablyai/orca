import { Loader2 } from 'lucide-react'
import type { WorkspaceSpaceWorktree } from '../../../../shared/workspace-space-types'
import { Badge } from '../ui/badge'
import { getWorkspaceSpaceStatusLabel } from './workspace-space-format'
import { translate } from '@/i18n/i18n'
import type { WorkspaceDecisionDetails } from './workspace-space-decision-details'
import type { WorkspaceSpaceDeleteState } from './workspace-space-manager-state-types'

export function WorkspaceSpaceStatusBadge({
  worktree,
  decisionDetails,
  deleteState
}: {
  worktree: WorkspaceSpaceWorktree
  decisionDetails?: WorkspaceDecisionDetails
  deleteState?: WorkspaceSpaceDeleteState
}): React.JSX.Element {
  if (deleteState?.isDeleting) {
    return (
      <Badge variant="outline" className="gap-1.5 text-muted-foreground">
        <Loader2 className="size-3 animate-spin" />
        {translate('auto.components.status.bar.WorkspaceSpaceManagerPanel.33653dbac2', 'Deleting')}
      </Badge>
    )
  }
  if (deleteState?.error) {
    return (
      <Badge variant="outline" className="border-destructive/30 text-destructive">
        {translate('auto.components.status.bar.WorkspaceSpaceManagerPanel.39801484e0', 'Failed')}
      </Badge>
    )
  }
  if (worktree.status !== 'ok') {
    return (
      <Badge variant="outline" className="border-destructive/30 text-destructive">
        {getWorkspaceSpaceStatusLabel(worktree.status)}
      </Badge>
    )
  }
  if (worktree.isMainWorktree) {
    return (
      <Badge variant="outline">
        {translate(
          'auto.components.status.bar.WorkspaceSpaceManagerPanel.2b501ee391',
          'Keep: main'
        )}
      </Badge>
    )
  }
  if (decisionDetails?.isActive) {
    return (
      <Badge variant="outline">
        {translate(
          'auto.components.status.bar.WorkspaceSpaceManagerPanel.7f7895514e',
          'Keep: active'
        )}
      </Badge>
    )
  }
  if ((decisionDetails?.changedFileCount ?? 0) > 0) {
    return (
      <Badge variant="outline">
        {translate(
          'auto.components.status.bar.WorkspaceSpaceManagerPanel.7ab8d7e2d7',
          'Keep: changed files'
        )}
      </Badge>
    )
  }
  if (decisionDetails?.changedFileCount === null) {
    return (
      <Badge variant="outline">
        {translate(
          'auto.components.status.bar.WorkspaceSpaceManagerPanel.ec7b076a75',
          'Keep: git not checked'
        )}
      </Badge>
    )
  }
  if ((decisionDetails?.dirtyEditorBufferCount ?? 0) > 0) {
    return (
      <Badge variant="outline">
        {translate(
          'auto.components.status.bar.WorkspaceSpaceManagerPanel.2055bc6a5a',
          'Keep: unsaved edits'
        )}
      </Badge>
    )
  }
  if (
    (decisionDetails?.activeAgentCount ?? 0) > 0 ||
    (decisionDetails?.liveTerminalCount ?? 0) > 0 ||
    (decisionDetails?.browserTabCount ?? 0) > 0
  ) {
    return (
      <Badge variant="outline">
        {translate(
          'auto.components.status.bar.WorkspaceSpaceManagerPanel.cbc343a7a8',
          'Keep: in use'
        )}
      </Badge>
    )
  }
  if (
    decisionDetails?.reviewLabel ||
    decisionDetails?.issueLabel ||
    decisionDetails?.linearIssueLabel
  ) {
    return (
      <Badge variant="outline">
        {translate(
          'auto.components.status.bar.WorkspaceSpaceManagerPanel.720870a18e',
          'Keep: linked'
        )}
      </Badge>
    )
  }
  return (
    <Badge
      variant="outline"
      className="border-emerald-500/35 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
    >
      {translate('auto.components.status.bar.WorkspaceSpaceManagerPanel.7d7745bb8f', 'Can delete')}
    </Badge>
  )
}
