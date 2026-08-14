import type React from 'react'
import { PendingWorktreeRow } from './PendingWorktreeRow'
import ImportedWorktreesVisibilityLine from './ImportedWorktreesVisibilityLine'
import NewExternalWorktreesInboxLine from './NewExternalWorktreesInboxLine'
import type { ImportedWorktreeCardActionState } from './imported-worktrees-card-actions'
import type { NewExternalWorktreesInboxActionState } from './new-external-worktrees-inbox-actions'
import { canKeepImportedWorktreesHidden } from './worktree-list-render-row-model'
import { getVirtualRowTransform, type RenderRow } from './worktree-list-virtual-rows'
import type { Repo } from '../../../../shared/types'

type AuxiliaryRow = Extract<
  RenderRow,
  { type: 'imported-worktrees-card' | 'new-external-worktrees-inbox' | 'pending-creation' }
>
type Props = {
  row: AuxiliaryRow
  virtualItem: { key: React.Key; index: number; start: number }
  measureVirtualRowElement: (element: HTMLDivElement | null) => void
  importedWorktreeCardActionState: ReadonlyMap<string, ImportedWorktreeCardActionState>
  newExternalWorktreeInboxActionState: ReadonlyMap<string, NewExternalWorktreesInboxActionState>
  handleShowImportedWorktrees: (projectId: string) => void
  handleKeepImportedWorktreesHidden: (projectId: string) => void
  handleOpenWorktreeVisibility: (repo: Repo) => void
  handleOpenSuppressExternalWorktreeInbox: (projectId: string) => void
}

export function WorktreeListAuxiliaryRow({
  row,
  virtualItem,
  measureVirtualRowElement,
  importedWorktreeCardActionState,
  newExternalWorktreeInboxActionState,
  handleShowImportedWorktrees,
  handleKeepImportedWorktreesHidden,
  handleOpenWorktreeVisibility,
  handleOpenSuppressExternalWorktreeInbox
}: Props): React.JSX.Element {
  const shell = (content: React.ReactNode, className = 'absolute left-0 right-0 top-0') => (
    <div
      key={virtualItem.key}
      role="presentation"
      data-worktree-virtual-row
      data-worktree-virtual-row-key={String(virtualItem.key)}
      data-worktree-virtual-row-start={virtualItem.start}
      data-index={virtualItem.index}
      ref={measureVirtualRowElement}
      className={className}
      style={{ transform: getVirtualRowTransform(virtualItem.start) }}
    >
      {content}
    </div>
  )
  if (row.type === 'pending-creation') {
    return shell(
      <PendingWorktreeRow creationId={row.creationId} />,
      'absolute left-0 right-0 top-0 px-2 pb-1.5'
    )
  }
  if (row.type === 'imported-worktrees-card') {
    const actionState = importedWorktreeCardActionState.get(row.repo.id)
    return shell(
      <ImportedWorktreesVisibilityLine
        repoDisplayName={row.repo.displayName}
        hiddenWorktrees={row.hiddenWorktrees}
        placement={row.placement}
        pending={actionState?.pending ?? false}
        error={actionState?.error ?? null}
        onShow={() => handleShowImportedWorktrees(row.repo.id)}
        onKeepHidden={
          canKeepImportedWorktreesHidden(row, actionState)
            ? () => handleKeepImportedWorktreesHidden(row.repo.id)
            : undefined
        }
      />
    )
  }
  const actionState = newExternalWorktreeInboxActionState.get(row.repo.id)
  return shell(
    <NewExternalWorktreesInboxLine
      repoDisplayName={row.repo.displayName}
      inboxCount={row.inboxWorktrees.length}
      pending={actionState?.pending ?? false}
      error={actionState?.error ?? null}
      onReview={() => handleOpenWorktreeVisibility(row.repo)}
      onSuppress={() => handleOpenSuppressExternalWorktreeInbox(row.repo.id)}
    />
  )
}
