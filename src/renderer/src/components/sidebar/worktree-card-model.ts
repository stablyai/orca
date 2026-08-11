import type React from 'react'

import type { Repo, WorkspaceStatus, Worktree } from '../../../../shared/types'
import type { WorktreeCardPrDisplay } from './worktree-card-pr-display'

export type WorktreeRenameRequest = {
  worktreeId: string
  rowKey?: string
}

export type ActiveSurfaceVariant = 'primary' | 'secondary'

export type WorktreeCardProps = {
  worktree: Worktree
  repo: Repo | undefined
  isActive: boolean
  isCurrentWorktree?: boolean
  isActiveSurface?: boolean
  activeSurfaceVariant?: ActiveSurfaceVariant
  isMultiSelected?: boolean
  revealHighlight?: boolean
  revealHighlightTone?: 'default' | 'ai'
  selectedWorktrees?: readonly Worktree[]
  hideRepoBadge?: boolean
  hostContextLabel?: string
  inPinnedSection?: boolean
  activationRowKey?: string
  renameRowKey?: string
  contentIndent?: number
  flushSurface?: boolean
  lineageChildCount?: number
  lineageCollapsed?: boolean
  lineageChildren?: React.ReactNode
  lineageChildrenStyle?: React.CSSProperties
  onLineageToggle?: (event: React.MouseEvent<HTMLButtonElement>) => void
  isLineageDropTarget?: boolean
  onActivate?: () => void
  onImmediateActivate?: (worktreeId: string, rowKey: string | undefined) => void
  onSelectionGesture?: (event: React.MouseEvent<HTMLElement>, worktreeId: string) => boolean
  onContextMenuSelect?: (
    event: React.MouseEvent<HTMLElement>,
    worktree: Worktree
  ) => readonly Worktree[]
  onAssignWorkspaceStatus?: (worktreeIds: readonly string[], status: WorkspaceStatus) => void
  onCardDragStart?: (
    event: React.DragEvent<HTMLDivElement>,
    worktreeId: string,
    draggedIds: readonly string[]
  ) => void
  onCardDragEnd?: (event: React.DragEvent<HTMLDivElement>) => void
  nativeDragEnabled?: boolean
  affiliateListMode?: boolean
  statusPrDisplay?: WorktreeCardPrDisplay | null
}

type DefaultedWorktreeCardProp =
  | 'isActiveSurface'
  | 'activeSurfaceVariant'
  | 'isMultiSelected'
  | 'revealHighlight'
  | 'revealHighlightTone'
  | 'nativeDragEnabled'
  | 'inPinnedSection'
  | 'contentIndent'
  | 'flushSurface'
  | 'lineageChildCount'
  | 'lineageCollapsed'
  | 'isLineageDropTarget'
  | 'affiliateListMode'
  | 'statusPrDisplay'

export type ResolvedWorktreeCardProps = Omit<WorktreeCardProps, DefaultedWorktreeCardProp> & {
  isActiveSurface: boolean
  activeSurfaceVariant: ActiveSurfaceVariant
  isMultiSelected: boolean
  revealHighlight: boolean
  revealHighlightTone: 'default' | 'ai'
  nativeDragEnabled: boolean
  inPinnedSection: boolean
  contentIndent: number
  flushSurface: boolean
  lineageChildCount: number
  lineageCollapsed: boolean
  isLineageDropTarget: boolean
  affiliateListMode: boolean
  statusPrDisplay: WorktreeCardPrDisplay | null
}

export const EMPTY_WORKSPACE_PORTS = []
export const HOSTED_REVIEW_CARD_REFRESH_INTERVAL_MS = 60_000

export function shouldBeginWorktreeRename(
  request: WorktreeRenameRequest | null,
  worktreeId: string,
  rowKey: string | undefined
): boolean {
  return (
    request?.worktreeId === worktreeId &&
    (request.rowKey === undefined || request.rowKey === rowKey)
  )
}

export function formatSparseDirectoryPreview(directories: string[]): string {
  const preview = directories.slice(0, 4).join(', ')
  return directories.length <= 4 ? preview : `${preview}, +${directories.length - 4} more`
}

export function isWebClient(): boolean {
  return Boolean((window as unknown as { __ORCA_WEB_CLIENT__?: boolean }).__ORCA_WEB_CLIENT__)
}

export function getDirectoryName(folderPath: string): string {
  const normalized = folderPath.replace(/[\\/]+$/, '')
  const parts = normalized.split(/[\\/]+/)
  return parts.at(-1) || normalized || folderPath
}
