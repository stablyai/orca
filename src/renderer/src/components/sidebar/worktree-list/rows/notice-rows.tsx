import React from 'react'
import type { VirtualItem } from '@tanstack/react-virtual'
import type { Row } from '../grouping/row-types'
import { getVirtualRowTransform } from '../viewport/virtual-rows'
import { PendingWorktreeRow } from '../../PendingWorktreeRow'
import ImportedWorktreesVisibilityLine from '../../ImportedWorktreesVisibilityLine'
import NewExternalWorktreesInboxLine from '../../NewExternalWorktreesInboxLine'
import type { ImportedWorktreeCardActionState } from '../../imported-worktrees-card-actions'
import type { NewExternalWorktreesInboxActionState } from '../../new-external-worktrees-inbox-actions'

export function canKeepImportedWorktreesHidden(
  row: Extract<Row, { type: 'imported-worktrees-card' }>,
  actionState: ImportedWorktreeCardActionState | undefined
): boolean {
  return row.placement === 'repo-group' && actionState?.forceVisible !== true
}

type NoticeRowFrameProps = {
  vItem: VirtualItem
  measureVirtualRowElement: (element: HTMLDivElement | null) => void
  className?: string
  children: React.ReactNode
}

// Every non-card sidebar row shares the same absolutely-positioned virtual frame.
function NoticeRowFrame({
  vItem,
  measureVirtualRowElement,
  className = 'absolute left-0 right-0 top-0',
  children
}: NoticeRowFrameProps): React.JSX.Element {
  return (
    <div
      role="presentation"
      data-worktree-virtual-row
      data-worktree-virtual-row-key={String(vItem.key)}
      data-worktree-virtual-row-start={vItem.start}
      data-index={vItem.index}
      ref={measureVirtualRowElement}
      className={className}
      style={{ transform: getVirtualRowTransform(vItem.start) }}
    >
      {children}
    </div>
  )
}

export function renderImportedWorktreesVirtualRow(args: {
  row: Extract<Row, { type: 'imported-worktrees-card' }>
  vItem: VirtualItem
  measureVirtualRowElement: (element: HTMLDivElement | null) => void
  actionState: ImportedWorktreeCardActionState | undefined
  onShow: (projectId: string) => void
  onKeepHidden: (projectId: string) => void
}): React.JSX.Element {
  const { row, actionState } = args
  return (
    <NoticeRowFrame
      key={args.vItem.key}
      vItem={args.vItem}
      measureVirtualRowElement={args.measureVirtualRowElement}
    >
      <ImportedWorktreesVisibilityLine
        repoDisplayName={row.repo.displayName}
        hiddenWorktrees={row.hiddenWorktrees}
        placement={row.placement}
        pending={actionState?.pending ?? false}
        error={actionState?.error ?? null}
        onShow={() => args.onShow(row.repo.id)}
        onKeepHidden={
          canKeepImportedWorktreesHidden(row, actionState)
            ? () => args.onKeepHidden(row.repo.id)
            : undefined
        }
      />
    </NoticeRowFrame>
  )
}

export function renderNewExternalWorktreesInboxVirtualRow(args: {
  row: Extract<Row, { type: 'new-external-worktrees-inbox' }>
  vItem: VirtualItem
  measureVirtualRowElement: (element: HTMLDivElement | null) => void
  actionState: NewExternalWorktreesInboxActionState | undefined
  onReview: (repo: Extract<Row, { type: 'new-external-worktrees-inbox' }>['repo']) => void
  onSuppress: (projectId: string) => void
}): React.JSX.Element {
  const { row, actionState } = args
  return (
    <NoticeRowFrame
      key={args.vItem.key}
      vItem={args.vItem}
      measureVirtualRowElement={args.measureVirtualRowElement}
    >
      <NewExternalWorktreesInboxLine
        repoDisplayName={row.repo.displayName}
        inboxCount={row.inboxWorktrees.length}
        pending={actionState?.pending ?? false}
        error={actionState?.error ?? null}
        onReview={() => args.onReview(row.repo)}
        onSuppress={() => args.onSuppress(row.repo.id)}
      />
    </NoticeRowFrame>
  )
}

export function renderPendingCreationVirtualRow(args: {
  row: Extract<Row, { type: 'pending-creation' }>
  vItem: VirtualItem
  measureVirtualRowElement: (element: HTMLDivElement | null) => void
}): React.JSX.Element {
  return (
    <NoticeRowFrame
      key={args.vItem.key}
      vItem={args.vItem}
      measureVirtualRowElement={args.measureVirtualRowElement}
      className="absolute left-0 right-0 top-0 px-2 pb-1.5"
    >
      <PendingWorktreeRow creationId={args.row.creationId} />
    </NoticeRowFrame>
  )
}
