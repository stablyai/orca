import { normalizeRuntimePathSeparators } from '../../../../shared/cross-platform-path'
import type { AiVaultScope } from '../../../../shared/ai-vault-types'
import { translate } from '@/i18n/i18n'
import type {
  AiVaultSessionWorktreeInfo,
  AiVaultSessionWorktreeStatus
} from './ai-vault-session-worktree'

export function canJumpToAiVaultSessionWorktree(
  worktreeInfo: AiVaultSessionWorktreeInfo | null
): boolean {
  return Boolean(
    worktreeInfo?.worktreeId &&
    worktreeInfo.status !== 'archived' &&
    worktreeInfo.status !== 'unavailable'
  )
}

// Why: a session in the worktree you're already viewing has nowhere to jump,
// so we hide the affordance rather than offering a self-jump (the "Current
// worktree" badge already signals where it lives).
export function isAiVaultSessionInCurrentWorktree(
  worktreeInfo: AiVaultSessionWorktreeInfo | null
): boolean {
  return worktreeInfo?.status === 'current'
}

export function aiVaultWorktreeJumpTooltip(
  worktreeInfo: AiVaultSessionWorktreeInfo | null
): string {
  if (canJumpToAiVaultSessionWorktree(worktreeInfo)) {
    return translate(
      'auto.components.right.sidebar.AiVaultSessionWorktree.jumpToWorktree',
      'Jump to Worktree'
    )
  }
  if (!worktreeInfo) {
    return translate(
      'auto.components.right.sidebar.AiVaultSessionWorktree.noRecordedWorktree',
      'No worktree was recorded for this session.'
    )
  }
  if (worktreeInfo.status === 'archived') {
    return translate(
      'auto.components.right.sidebar.AiVaultSessionWorktree.archivedJumpUnavailable',
      'This session is in an archived worktree.'
    )
  }
  if (worktreeInfo.status === 'unavailable') {
    return translate(
      'auto.components.right.sidebar.AiVaultSessionWorktree.noActiveWorktreeMatch',
      'No active worktree matches this session.'
    )
  }
  return translate(
    'auto.components.right.sidebar.AiVaultSessionWorktree.noActiveWorktreeTarget',
    'No active worktree is available.'
  )
}

export function aiVaultWorktreeCompactPath(pathValue: string): string {
  const parts = normalizeRuntimePathSeparators(pathValue).split('/').filter(Boolean)
  if (parts.length >= 2) {
    return parts.slice(-2).join('/')
  }
  return parts[0] ?? pathValue
}

export function shouldShowAiVaultSessionWorktreeLine(
  worktreeInfo: AiVaultSessionWorktreeInfo | null,
  options?: { vaultScope?: AiVaultScope }
): worktreeInfo is AiVaultSessionWorktreeInfo {
  if (!worktreeInfo) {
    return false
  }
  // Why: workspace scope already limits history to the active workspace; the
  // worktree row adds no value when the session lives in the worktree on screen.
  if (options?.vaultScope === 'workspace' && worktreeInfo.status === 'current') {
    return false
  }
  return true
}

export function shouldShowAiVaultWorktreeStatusBadge(
  status: AiVaultSessionWorktreeStatus,
  options?: { vaultScope?: AiVaultScope }
): boolean {
  // Why: "active" repeats the branch label without adding scan value in dense rows.
  if (status === 'active') {
    return false
  }
  // Why: workspace scope already filters to the active workspace, so "Current
  // worktree" is redundant in the default history view.
  if (status === 'current' && options?.vaultScope === 'workspace') {
    return false
  }
  return true
}

export function aiVaultWorktreeStatusLabel(status: AiVaultSessionWorktreeStatus): string {
  if (status === 'current') {
    return translate(
      'auto.components.right.sidebar.AiVaultSessionWorktree.currentWorktree',
      'Current worktree'
    )
  }
  if (status === 'active') {
    return translate(
      'auto.components.right.sidebar.AiVaultSessionWorktree.activeWorktree',
      'Active worktree'
    )
  }
  if (status === 'archived') {
    return translate(
      'auto.components.right.sidebar.AiVaultSessionWorktree.archivedWorktree',
      'Archived worktree'
    )
  }
  return translate(
    'auto.components.right.sidebar.AiVaultSessionWorktree.unavailableWorktree',
    'Unavailable worktree'
  )
}
