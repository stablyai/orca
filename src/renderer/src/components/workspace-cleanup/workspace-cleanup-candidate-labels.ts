import { translate } from '@/i18n/i18n'
import type { WorkspaceCleanupBlocker } from '../../../../shared/workspace-cleanup'

type ContextDetailKind = 'terminal' | 'editor' | 'browser' | 'diff' | 'agent'

export function getWorkspaceCleanupBlockerLabel(blocker: WorkspaceCleanupBlocker): string {
  switch (blocker) {
    case 'main-worktree':
      return translate(
        'auto.components.workspace.cleanup.candidateRow.mainWorkspaceBlocker',
        'Main workspace'
      )
    case 'folder-repo':
      return translate(
        'auto.components.workspace.cleanup.candidateRow.folderProjectBlocker',
        'Folder project'
      )
    case 'pinned':
      return translate('auto.components.workspace.cleanup.candidateRow.pinnedBlocker', 'Pinned')
    case 'active-workspace':
      return translate(
        'auto.components.workspace.cleanup.candidateRow.activeWorkspaceBlocker',
        'Active workspace'
      )
    case 'running-terminal':
      return translate(
        'auto.components.workspace.cleanup.candidateRow.runningTerminalBlocker',
        'Running terminal process'
      )
    case 'terminal-liveness-unknown':
      return translate(
        'auto.components.workspace.cleanup.candidateRow.terminalLivenessUnknownBlocker',
        'Terminal liveness unknown'
      )
    case 'dirty-editor-buffer':
      return translate(
        'auto.components.workspace.cleanup.candidateRow.dirtyEditorBufferBlocker',
        'Unsaved editor buffer'
      )
    case 'volatile-local-context':
      return translate(
        'auto.components.workspace.cleanup.candidateRow.volatileLocalContextBlocker',
        'Volatile local context'
      )
    case 'recent-visible-context':
      return translate(
        'auto.components.workspace.cleanup.candidateRow.recentVisibleContextBlocker',
        'Recently visited tabs'
      )
    case 'live-agent':
      return translate(
        'auto.components.workspace.cleanup.candidateRow.liveAgentBlocker',
        'Active agent'
      )
    case 'ssh-disconnected':
      return translate(
        'auto.components.workspace.cleanup.candidateRow.sshDisconnectedBlocker',
        'Remote unavailable'
      )
    case 'git-status-error':
      return translate(
        'auto.components.workspace.cleanup.candidateRow.gitStatusErrorBlocker',
        'Git status unavailable'
      )
    case 'dirty-files':
      return translate(
        'auto.components.workspace.cleanup.candidateRow.dirtyFilesBlocker',
        'Changed files'
      )
    case 'unpushed-commits':
      return getUnpushedCommitsLabel()
    case 'unknown-base':
      return translate(
        'auto.components.workspace.cleanup.candidateRow.unknownBaseBlocker',
        'Could not verify unpushed commits'
      )
    case 'dismissed':
      return translate('auto.components.workspace.cleanup.candidateRow.dismissedBlocker', 'Ignored')
  }
}

export function formatWorkspaceCleanupGitStatusLabel(label: string): string {
  switch (label) {
    case 'Clean':
      return translate('auto.components.workspace.cleanup.candidateRow.cleanGit', 'Clean git')
    case 'Dirty':
      return translate('auto.components.workspace.cleanup.candidateRow.dirtyGit', 'Dirty git')
    case 'Unpushed':
      return getUnpushedCommitsLabel()
    case 'Unknown':
      return translate('auto.components.workspace.cleanup.candidateRow.gitUnknown', 'Git unknown')
  }
  return translate('auto.components.workspace.cleanup.candidateRow.gitUnknown', 'Git unknown')
}

export function getNoUnpushedCommitsLabel(): string {
  return translate(
    'auto.components.workspace.cleanup.candidateRow.noUnpushedCommits',
    'No unpushed commits'
  )
}

export function getUnpushedCommitsLabel(): string {
  return translate(
    'auto.components.workspace.cleanup.candidateRow.unpushedCommits',
    'Unpushed commits'
  )
}

export function formatUnpushedCommitCount(count: number): string {
  return translate(
    'auto.components.workspace.cleanup.candidateRow.unpushedCommitsCount',
    'Unpushed commits: {{value0}}',
    { value0: count }
  )
}

export function getUncommittedChangesLabel(): string {
  return translate(
    'auto.components.workspace.cleanup.candidateRow.uncommittedChanges',
    'Uncommitted changes'
  )
}

export function getGitStatusUnknownLabel(): string {
  return translate(
    'auto.components.workspace.cleanup.candidateRow.gitStatusUnknown',
    'Git status unknown'
  )
}

export function formatWorkspaceCleanupContextDetail(
  kind: ContextDetailKind,
  count: number
): string {
  switch (kind) {
    case 'terminal':
      return translate(
        'auto.components.workspace.cleanup.candidateRow.terminalTabsCount',
        'Terminal tabs: {{value0}}',
        { value0: count }
      )
    case 'editor':
      return translate(
        'auto.components.workspace.cleanup.candidateRow.editorTabsCount',
        'Editor tabs: {{value0}}',
        { value0: count }
      )
    case 'browser':
      return translate(
        'auto.components.workspace.cleanup.candidateRow.browserTabsCount',
        'Browser tabs: {{value0}}',
        { value0: count }
      )
    case 'diff':
      return translate(
        'auto.components.workspace.cleanup.candidateRow.diffNotesCount',
        'Diff notes: {{value0}}',
        { value0: count }
      )
    case 'agent':
      return translate(
        'auto.components.workspace.cleanup.candidateRow.completedAgentsCount',
        'Completed agents: {{value0}}',
        { value0: count }
      )
  }
}

export function formatWorkspaceCleanupContextCount(count: number): string {
  return translate(
    'auto.components.workspace.cleanup.candidateRow.contextCount',
    'Context: {{value0}}',
    { value0: count }
  )
}
