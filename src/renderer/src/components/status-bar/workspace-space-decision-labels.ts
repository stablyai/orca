import type { WorkspaceSpaceWorktree } from '../../../../shared/workspace-disk-space/workspace-space-types'
import { translate } from '@/i18n/i18n'
import type { Translate } from '@/i18n/use-translate'
import { getWorkspaceSpaceStatusLabel } from './workspace-space-format'
import type { WorkspaceDecisionDetails } from './workspace-space-decision-details'
import type { WorkspaceGitRefreshState } from './workspace-space-manager-state-types'

function formatActiveAgents(count: number, t: Translate = translate): string {
  return t(
    'auto.components.status.bar.workspaceSpaceDecision.activeAgents',
    '{{count}} active agents',
    { count: count, defaultValue_one: '{{count}} active agent' }
  )
}

function formatCompletedAgents(count: number, t: Translate = translate): string {
  return t(
    'auto.components.status.bar.workspaceSpaceDecision.completedAgents',
    '{{count}} completed agents',
    { count: count, defaultValue_one: '{{count}} completed agent' }
  )
}

export function getAgentDecisionLabel(
  details: WorkspaceDecisionDetails,
  t: Translate = translate
): string {
  const { activeAgentCount, completedAgentCount } = details
  if (activeAgentCount > 0 && completedAgentCount > 0) {
    return t(
      'auto.components.status.bar.workspaceSpaceDecision.activeAndCompletedAgents',
      '{{active}}, {{completed}}',
      {
        active: formatActiveAgents(activeAgentCount, t),
        completed: formatCompletedAgents(completedAgentCount, t)
      }
    )
  }
  if (activeAgentCount > 0) {
    return formatActiveAgents(activeAgentCount, t)
  }
  if (completedAgentCount > 0) {
    return t(
      'auto.components.status.bar.workspaceSpaceDecision.completedAgentsRetained',
      '{{count}} completed agents retained',
      { count: completedAgentCount, defaultValue_one: '{{count}} completed agent retained' }
    )
  }
  return t(
    'auto.components.status.bar.workspaceSpaceDecision.noTrackedAgents',
    'No tracked agents running'
  )
}

export function getTerminalDecisionLabel(
  details: WorkspaceDecisionDetails,
  t: Translate = translate
): string {
  const { terminalTabCount, liveTerminalCount } = details
  if (terminalTabCount === 0) {
    return t('auto.components.status.bar.workspaceSpaceDecision.noTerminalTabs', 'No terminal tabs')
  }
  return t(
    'auto.components.status.bar.workspaceSpaceDecision.liveTerminalTabs',
    '{{live}} live of {{count}} terminal tabs',
    {
      live: liveTerminalCount,
      count: terminalTabCount,
      defaultValue_one: '{{live}} live of {{count}} terminal tab'
    }
  )
}

export function getGitDecisionLabel(
  details: WorkspaceDecisionDetails,
  gitRefreshState?: WorkspaceGitRefreshState,
  t: Translate = translate
): string {
  const { changedFileCount } = details
  if (changedFileCount === null) {
    if (gitRefreshState?.error) {
      return t(
        'auto.components.status.bar.workspaceSpaceDecision.gitStatusUnavailable',
        'Git status unavailable: {{error}}',
        { error: gitRefreshState.error }
      )
    }
    return t(
      'auto.components.status.bar.workspaceSpaceDecision.gitStatusNotLoaded',
      'Git status has not loaded yet'
    )
  }
  if (changedFileCount === 0) {
    return t(
      'auto.components.status.bar.workspaceSpaceDecision.noUncommittedFiles',
      'No uncommitted files'
    )
  }
  return t(
    'auto.components.status.bar.workspaceSpaceDecision.changedFiles',
    '{{count}} changed files',
    { count: changedFileCount, defaultValue_one: '{{count}} changed file' }
  )
}

export function getEditorDecisionLabel(
  details: WorkspaceDecisionDetails,
  t: Translate = translate
): string {
  const { openEditorFileCount, dirtyEditorBufferCount } = details
  if (openEditorFileCount === 0) {
    return t(
      'auto.components.status.bar.workspaceSpaceDecision.noEditorFiles',
      'No editor files open'
    )
  }
  if (dirtyEditorBufferCount === 0) {
    return t(
      'auto.components.status.bar.workspaceSpaceDecision.editorFilesOpen',
      '{{count}} editor files open',
      { count: openEditorFileCount, defaultValue_one: '{{count}} editor file open' }
    )
  }
  return t(
    'auto.components.status.bar.workspaceSpaceDecision.dirtyOfOpen',
    '{{dirty}} of {{open}}',
    {
      dirty: t(
        'auto.components.status.bar.workspaceSpaceDecision.dirtyEditorBuffers',
        '{{count}} dirty editor buffers',
        { count: dirtyEditorBufferCount, defaultValue_one: '{{count}} dirty editor buffer' }
      ),
      open: t(
        'auto.components.status.bar.workspaceSpaceDecision.openFiles',
        '{{count}} open files',
        { count: openEditorFileCount, defaultValue_one: '{{count}} open file' }
      )
    }
  )
}

export function getDeleteDecisionLabel(
  worktree: WorkspaceSpaceWorktree,
  details: WorkspaceDecisionDetails,
  t: Translate = translate
): string {
  if (details.isActive) {
    return t(
      'auto.components.status.bar.workspaceSpaceDecision.activeWorkspace',
      'This is the active workspace'
    )
  }
  if (worktree.status !== 'ok') {
    return worktree.error ?? getWorkspaceSpaceStatusLabel(worktree.status, t)
  }
  if (worktree.isMainWorktree) {
    return t(
      'auto.components.status.bar.workspaceSpaceDecision.mainWorktreeProtected',
      'Main worktree is protected'
    )
  }
  if (!worktree.canDelete) {
    return t(
      'auto.components.status.bar.workspaceSpaceDecision.workspaceProtected',
      'Workspace is protected'
    )
  }
  return t(
    'auto.components.status.bar.workspaceSpaceDecision.canDeleteAfterReview',
    'Can be deleted after review'
  )
}
