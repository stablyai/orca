import type { WorkspaceSpaceWorktree } from '../../../../shared/workspace-space-types'
import { translate } from '@/i18n/i18n'
import { getWorkspaceSpaceStatusLabel } from './workspace-space-format'
import type { WorkspaceDecisionDetails } from './workspace-space-decision-details'
import type { WorkspaceGitRefreshState } from './workspace-space-manager-state-types'

function formatActiveAgents(count: number): string {
  return count === 1
    ? translate(
        'auto.components.status.bar.workspaceSpaceDecision.activeAgents_one',
        '{{count}} active agent',
        { count: count }
      )
    : translate(
        'auto.components.status.bar.workspaceSpaceDecision.activeAgents_other',
        '{{count}} active agents',
        { count: count }
      )
}

function formatCompletedAgents(count: number): string {
  return count === 1
    ? translate(
        'auto.components.status.bar.workspaceSpaceDecision.completedAgents_one',
        '{{count}} completed agent',
        { count: count }
      )
    : translate(
        'auto.components.status.bar.workspaceSpaceDecision.completedAgents_other',
        '{{count}} completed agents',
        { count: count }
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
    return completedAgentCount === 1
      ? translate(
          'auto.components.status.bar.workspaceSpaceDecision.completedAgentsRetained_one',
          '{{count}} completed agent retained',
          { count: completedAgentCount }
        )
      : translate(
          'auto.components.status.bar.workspaceSpaceDecision.completedAgentsRetained_other',
          '{{count}} completed agents retained',
          { count: completedAgentCount }
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
  return terminalTabCount === 1
    ? translate(
        'auto.components.status.bar.workspaceSpaceDecision.liveTerminalTabs_one',
        '{{live}} live of {{count}} terminal tab',
        {
          live: liveTerminalCount,
          count: terminalTabCount
        }
      )
    : translate(
        'auto.components.status.bar.workspaceSpaceDecision.liveTerminalTabs_other',
        '{{live}} live of {{count}} terminal tabs',
        {
          live: liveTerminalCount,
          count: terminalTabCount
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
  return changedFileCount === 1
    ? translate(
        'auto.components.status.bar.workspaceSpaceDecision.changedFiles_one',
        '{{count}} changed file',
        { count: changedFileCount }
      )
    : translate(
        'auto.components.status.bar.workspaceSpaceDecision.changedFiles_other',
        '{{count}} changed files',
        { count: changedFileCount }
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
    return openEditorFileCount === 1
      ? translate(
          'auto.components.status.bar.workspaceSpaceDecision.editorFilesOpen_one',
          '{{count}} editor file open',
          { count: openEditorFileCount }
        )
      : translate(
          'auto.components.status.bar.workspaceSpaceDecision.editorFilesOpen_other',
          '{{count}} editor files open',
          { count: openEditorFileCount }
        )
  }
  return translate(
    'auto.components.status.bar.workspaceSpaceDecision.dirtyOfOpen',
    '{{dirty}} of {{open}}',
    {
      dirty:
        dirtyEditorBufferCount === 1
          ? translate(
              'auto.components.status.bar.workspaceSpaceDecision.dirtyEditorBuffers_one',
              '{{count}} dirty editor buffer',
              { count: dirtyEditorBufferCount }
            )
          : translate(
              'auto.components.status.bar.workspaceSpaceDecision.dirtyEditorBuffers_other',
              '{{count}} dirty editor buffers',
              { count: dirtyEditorBufferCount }
            ),
      open:
        openEditorFileCount === 1
          ? translate(
              'auto.components.status.bar.workspaceSpaceDecision.openFiles_one',
              '{{count}} open file',
              { count: openEditorFileCount }
            )
          : translate(
              'auto.components.status.bar.workspaceSpaceDecision.openFiles_other',
              '{{count}} open files',
              { count: openEditorFileCount }
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
