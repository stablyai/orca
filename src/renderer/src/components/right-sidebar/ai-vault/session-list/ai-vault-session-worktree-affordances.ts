import type { AiVaultScope } from '../../../../../../shared/ai-vault/contracts/ai-vault-types'
import { translate } from '@/i18n/i18n'
import type { Translate } from '@/i18n/use-translate'
import { parseWorkspaceKey } from '../../../../../../shared/workspace-scope'
import {
  canJumpToAiVaultSessionWorktree,
  type AiVaultSessionWorktreeInfo,
  type AiVaultSessionWorktreeStatus
} from '../../../../../../shared/ai-vault/session-display/ai-vault-session-worktree'

// Folder workspaces own sessions the way worktrees do, but a plain folder is never called a worktree.
export function isAiVaultFolderWorkspaceId(workspaceId: string | null | undefined): boolean {
  return Boolean(workspaceId && parseWorkspaceKey(workspaceId)?.type === 'folder')
}

export function aiVaultSessionWorkspaceHeading(
  workspaceId: string | null | undefined,
  t: Translate = translate
): string {
  return isAiVaultFolderWorkspaceId(workspaceId)
    ? t('auto.components.right.sidebar.AiVaultSessionDetails.folder', 'Folder')
    : t('auto.components.right.sidebar.AiVaultSessionDetails.worktree', 'Worktree')
}

export function aiVaultResumeInSessionWorkspaceLabel(
  workspaceId: string | null | undefined,
  t: Translate = translate
): string {
  return isAiVaultFolderWorkspaceId(workspaceId)
    ? t('auto.components.right.sidebar.AiVaultSessionDetails.resumeInFolder', 'Resume in Folder')
    : t(
        'auto.components.right.sidebar.AiVaultSessionDetails.resumeInWorktree',
        'Resume in Worktree'
      )
}

// Hide self-jumps; the Current worktree badge already identifies the destination.
export function isAiVaultSessionInCurrentWorktree(
  worktreeInfo: AiVaultSessionWorktreeInfo | null
): boolean {
  return worktreeInfo?.status === 'current'
}

export function aiVaultWorktreeJumpTooltip(
  worktreeInfo: AiVaultSessionWorktreeInfo | null,
  t: Translate = translate
): string {
  const folder = isAiVaultFolderWorkspaceId(worktreeInfo?.worktreeId)
  if (canJumpToAiVaultSessionWorktree(worktreeInfo)) {
    if (folder) {
      return t(
        'auto.components.right.sidebar.AiVaultSessionWorktree.jumpToFolder',
        'Jump to Folder'
      )
    }
    return t(
      'auto.components.right.sidebar.AiVaultSessionWorktree.jumpToWorktree',
      'Jump to Worktree'
    )
  }
  if (!worktreeInfo) {
    return t(
      'auto.components.right.sidebar.AiVaultSessionWorktree.noRecordedWorktree',
      'No worktree was recorded for this session.'
    )
  }
  if (worktreeInfo.status === 'archived') {
    if (folder) {
      return t(
        'auto.components.right.sidebar.AiVaultSessionWorktree.archivedFolderJumpUnavailable',
        'This session is in an archived folder.'
      )
    }
    return t(
      'auto.components.right.sidebar.AiVaultSessionWorktree.archivedJumpUnavailable',
      'This session is in an archived worktree.'
    )
  }
  if (worktreeInfo.status === 'unavailable') {
    return t(
      'auto.components.right.sidebar.AiVaultSessionWorktree.noActiveWorktreeMatch',
      'No active worktree matches this session.'
    )
  }
  return t(
    'auto.components.right.sidebar.AiVaultSessionWorktree.noActiveWorktreeTarget',
    'No active worktree is available.'
  )
}

export function shouldShowAiVaultSessionWorktreeLine(
  worktreeInfo: AiVaultSessionWorktreeInfo | null,
  options?: { vaultScope?: AiVaultScope }
): worktreeInfo is AiVaultSessionWorktreeInfo {
  if (!worktreeInfo) {
    return false
  }
  // Workspace scope already identifies the current worktree; omit its redundant row.
  if (options?.vaultScope === 'workspace' && worktreeInfo.status === 'current') {
    return false
  }
  return true
}

export function shouldShowAiVaultWorktreeStatusBadge(
  status: AiVaultSessionWorktreeStatus,
  options?: { vaultScope?: AiVaultScope }
): boolean {
  // Active repeats the branch label without adding information.
  if (status === 'active') {
    return false
  }
  // Workspace scope makes Current worktree redundant.
  if (status === 'current' && options?.vaultScope === 'workspace') {
    return false
  }
  return true
}

export function aiVaultWorktreeStatusLabel(
  status: AiVaultSessionWorktreeStatus,
  workspaceId?: string | null,
  t: Translate = translate
): string {
  if (isAiVaultFolderWorkspaceId(workspaceId)) {
    return aiVaultFolderStatusLabel(status, t)
  }
  if (status === 'current') {
    return t(
      'auto.components.right.sidebar.AiVaultSessionWorktree.currentWorktree',
      'Current worktree'
    )
  }
  if (status === 'active') {
    return t(
      'auto.components.right.sidebar.AiVaultSessionWorktree.activeWorktree',
      'Active worktree'
    )
  }
  if (status === 'archived') {
    return t(
      'auto.components.right.sidebar.AiVaultSessionWorktree.archivedWorktree',
      'Archived worktree'
    )
  }
  return t(
    'auto.components.right.sidebar.AiVaultSessionWorktree.unavailableWorktree',
    'Unavailable worktree'
  )
}

function aiVaultFolderStatusLabel(
  status: AiVaultSessionWorktreeStatus,
  t: Translate = translate
): string {
  if (status === 'current') {
    return t('auto.components.right.sidebar.AiVaultSessionWorktree.currentFolder', 'Current folder')
  }
  if (status === 'archived') {
    return t(
      'auto.components.right.sidebar.AiVaultSessionWorktree.archivedFolder',
      'Archived folder'
    )
  }
  return t('auto.components.right.sidebar.AiVaultSessionWorktree.activeFolder', 'Folder')
}
