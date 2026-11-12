import React from 'react'
import type { VirtualItem } from '@tanstack/react-virtual'
import type { Row } from '../../../../../../shared/sidebar-list/row-types'
import { getVirtualRowTransform } from '../viewport/virtual-rows'
import { PendingWorktreeRow } from './PendingWorktreeRow'
import ImportedWorktreesVisibilityLine from '../listing/ImportedWorktreesVisibilityLine'
import NewExternalWorktreesInboxLine from '../listing/NewExternalWorktreesInboxLine'
import type { ImportedWorktreeCardActionState } from '../listing/imported-worktrees-card-actions'
import type { NewExternalWorktreesInboxActionState } from '../listing/new-external-worktrees-inbox-actions'

type NoticeRowFrameProps = {
  vItem: VirtualItem
  measureVirtualRowElement: (element: HTMLDivElement | null) => void
  className?: string
  children: React.ReactNode
}

// Share the absolute virtual frame across non-card rows.
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
  actionStateByProjectId: ReadonlyMap<string, ImportedWorktreeCardActionState>
  onShow: (projectId: string) => void
  onKeepHidden: (projectId: string) => void
}): React.JSX.Element {
  const { row, actionStateByProjectId } = args
  const frame = (line: React.JSX.Element): React.JSX.Element => (
    <NoticeRowFrame
      key={args.vItem.key}
      vItem={args.vItem}
      measureVirtualRowElement={args.measureVirtualRowElement}
    >
      {line}
    </NoticeRowFrame>
  )
  if (row.placement === 'all-projects') {
    const states = row.projects.map((project) => actionStateByProjectId.get(project.repo.id))
    return frame(
      <ImportedWorktreesVisibilityLine
        hostContextLabel={row.hostContextLabel}
        hostContextHostId={row.hostContextHostId}
        hiddenWorktrees={row.projects.flatMap((project) => project.hiddenWorktrees)}
        pending={states.some((state) => state?.pending)}
        error={states.find((state) => state?.error)?.error ?? null}
        onShow={() => row.projects.forEach((project) => args.onShow(project.repo.id))}
      />
    )
  }
  const actionState = actionStateByProjectId.get(row.repo.id)
  return frame(
    <ImportedWorktreesVisibilityLine
      repoDisplayName={row.repo.displayName}
      hostContextLabel={row.hostContextLabel}
      hostContextHostId={row.hostContextHostId}
      hiddenWorktrees={row.hiddenWorktrees}
      pending={actionState?.pending ?? false}
      error={actionState?.error ?? null}
      onShow={() => args.onShow(row.repo.id)}
      onKeepHidden={
        actionState?.forceVisible !== true ? () => args.onKeepHidden(row.repo.id) : undefined
      }
    />
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
        hostContextLabel={row.hostContextLabel}
        hostContextHostId={row.hostContextHostId}
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
      <PendingWorktreeRow
        creationId={args.row.creationId}
        repoName={args.row.repo?.displayName ?? null}
      />
    </NoticeRowFrame>
  )
}
