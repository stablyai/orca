import type { WorkspaceSpaceWorktree } from '../../../../shared/workspace-space-types'
import { translate } from '@/i18n/i18n'
import { getWorkspaceSpaceStatusLabel } from './workspace-space-format'
import type { WorkspaceDecisionDetails } from './workspace-space-decision-details'
import type { WorkspaceGitRefreshState } from './workspace-space-manager-state-types'

function formatActiveAgents(count: number): string {
  return translate(
    'auto.components.status.bar.workspaceSpaceDecision.activeAgents',
    '{{count}} active agents',
    { count: count, defaultValue_one: '{{count}} active agent' }
  )
}

function formatCompletedAgents(count: number): string {
  return translate(
    'auto.components.status.bar.workspaceSpaceDecision.completedAgents',
    '{{count}} completed agents',
    { count: count, defaultValue_one: '{{count}} completed agent' }
  )
}

export function getAgentDecisionLabel(details: WorkspaceDecisionDetails): string {
  const { activeAgentCount, completedAgentCount } = details
  if (activeAgentCount > 0 && completedAgentCount > 0) {
    return translate(
      'auto.components.status.bar.workspaceSpaceDecision.activeAndCompletedAgents',
      '{{active}}, {{completed}}',
      {
        active: formatActiveAgents(activeAgentCount),
        completed: formatCompletedAgents(completedAgentCount)
      }
    )
  }
  if (activeAgentCount > 0) {
    return formatActiveAgents(activeAgentCount)
  }
  if (completedAgentCount > 0) {
    return translate(
      'auto.components.status.bar.workspaceSpaceDecision.completedAgentsRetained',
      '{{count}} completed agents retained',
      { count: completedAgentCount, defaultValue_one: '{{count}} completed agent retained' }
    )
  }
  return translate(
    'auto.components.status.bar.workspaceSpaceDecision.noTrackedAgents',
    'No tracked agents running'
  )
}

export function getTerminalDecisionLabel(details: WorkspaceDecisionDetails): string {
  const { terminalTabCount, liveTerminalCount } = details
  if (terminalTabCount === 0) {
    return translate(
      'auto.components.status.bar.workspaceSpaceDecision.noTerminalTabs',
      'No terminal tabs'
    )
  }
  return translate(
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
  gitRefreshState?: WorkspaceGitRefreshState
): string {
  const { changedFileCount } = details
  if (changedFileCount === null) {
    if (gitRefreshState?.error) {
      return translate(
        'auto.components.status.bar.workspaceSpaceDecision.gitStatusUnavailable',
        'Git status unavailable: {{error}}',
        { error: gitRefreshState.error }
      )
    }
    return translate(
      'auto.components.status.bar.workspaceSpaceDecision.gitStatusNotLoaded',
      'Git status has not loaded yet'
    )
  }
  if (changedFileCount === 0) {
    return translate(
      'auto.components.status.bar.workspaceSpaceDecision.noUncommittedFiles',
      'No uncommitted files'
    )
  }
  return translate(
    'auto.components.status.bar.workspaceSpaceDecision.changedFiles',
    '{{count}} changed files',
    { count: changedFileCount, defaultValue_one: '{{count}} changed file' }
  )
}

export function getEditorDecisionLabel(details: WorkspaceDecisionDetails): string {
  const { openEditorFileCount, dirtyEditorBufferCount } = details
  if (openEditorFileCount === 0) {
    return translate(
      'auto.components.status.bar.workspaceSpaceDecision.noEditorFiles',
      'No editor files open'
    )
  }
  if (dirtyEditorBufferCount === 0) {
    return translate(
      'auto.components.status.bar.workspaceSpaceDecision.editorFilesOpen',
      '{{count}} editor files open',
      { count: openEditorFileCount, defaultValue_one: '{{count}} editor file open' }
    )
  }
  return translate(
    'auto.components.status.bar.workspaceSpaceDecision.dirtyOfOpen',
    '{{dirty}} of {{open}}',
    {
      dirty: translate(
        'auto.components.status.bar.workspaceSpaceDecision.dirtyEditorBuffers',
        '{{count}} dirty editor buffers',
        { count: dirtyEditorBufferCount, defaultValue_one: '{{count}} dirty editor buffer' }
      ),
      open: translate(
        'auto.components.status.bar.workspaceSpaceDecision.openFiles',
        '{{count}} open files',
        { count: openEditorFileCount, defaultValue_one: '{{count}} open file' }
      )
    }
  )
}

export function getDeleteDecisionLabel(
  worktree: WorkspaceSpaceWorktree,
  details: WorkspaceDecisionDetails
): string {
  if (details.isActive) {
    return translate(
      'auto.components.status.bar.workspaceSpaceDecision.activeWorkspace',
      'This is the active workspace'
    )
  }
  if (worktree.status !== 'ok') {
    return worktree.error ?? getWorkspaceSpaceStatusLabel(worktree.status)
  }
  if (worktree.isMainWorktree) {
    return translate(
      'auto.components.status.bar.workspaceSpaceDecision.mainWorktreeProtected',
      'Main worktree is protected'
    )
  }
  if (!worktree.canDelete) {
    return translate(
      'auto.components.status.bar.workspaceSpaceDecision.workspaceProtected',
      'Workspace is protected'
    )
  }
  return translate(
    'auto.components.status.bar.workspaceSpaceDecision.canDeleteAfterReview',
    'Can be deleted after review'
  )
}
