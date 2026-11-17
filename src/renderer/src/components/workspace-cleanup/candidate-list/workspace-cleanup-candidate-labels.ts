import { translate } from '@/i18n/i18n'
import type { Translate } from '@/i18n/use-translate'
import type { WorkspaceCleanupBlocker } from '../../../../../shared/workspace-cleanup/workspace-cleanup'
import type { WorkspaceCleanupGitState } from '../../../../../shared/workspace-cleanup/workspace-cleanup-filter-model'
import type { WorktreeAtRiskLocalFiles } from '../../../../../shared/worktree/at-risk-local-files'
import { formatAtRiskLocalFileNames } from '@/lib/workspace/display/at-risk-local-files-label'

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
    case 'ignored-files':
      return translate(
        'components.workspace.cleanup.candidateRow.ignoredFilesBlocker',
        'Ignored local files'
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

export function formatWorkspaceCleanupIgnoredFilesLabel(
  files: WorktreeAtRiskLocalFiles | null | undefined,
  t: Translate = translate
): string {
  const names = files ? formatAtRiskLocalFileNames(files, t) : null
  if (names) {
    return t(
      'components.workspace.cleanup.candidateRow.ignoredFilesNamed',
      'Ignored files: {{value0}}',
      { value0: names }
    )
  }
  if (files && !files.complete) {
    return t(
      'components.workspace.cleanup.candidateRow.ignoredFilesUnchecked',
      'Ignored files not fully checked'
    )
  }
  return getWorkspaceCleanupBlockerLabel('ignored-files')
}

export function formatWorkspaceCleanupGitStatusLabel(
  state: WorkspaceCleanupGitState,
  t: Translate = translate
): string {
  switch (state) {
    case 'clean':
      return t('auto.components.workspace.cleanup.candidateRow.cleanGit', 'Clean git')
    case 'dirty':
      return t('auto.components.workspace.cleanup.candidateRow.dirtyGit', 'Dirty git')
    case 'unpushed':
      return getUnpushedCommitsLabel(t)
    case 'unknown':
      return t('auto.components.workspace.cleanup.candidateRow.gitUnknown', 'Git unknown')
  }
}

export function getWorkspaceCleanupGitChipLabel(
  state: WorkspaceCleanupGitState,
  t: Translate = translate
): string {
  switch (state) {
    case 'clean':
      return t('components.workspace.cleanup.candidateRow.gitChip.clean', 'Clean')
    case 'dirty':
      return t('components.workspace.cleanup.candidateRow.gitChip.dirty', 'Dirty')
    case 'unpushed':
      return t('components.workspace.cleanup.candidateRow.gitChip.unpushed', 'Unpushed')
    case 'unknown':
      return t('components.workspace.cleanup.candidateRow.gitChip.unknown', 'Unknown')
  }
}

export function getNoUnpushedCommitsLabel(t: Translate = translate): string {
  return t(
    'auto.components.workspace.cleanup.candidateRow.noUnpushedCommits',
    'No unpushed commits'
  )
}

export function getUnpushedCommitsLabel(t: Translate = translate): string {
  return t('auto.components.workspace.cleanup.candidateRow.unpushedCommits', 'Unpushed commits')
}

export function formatUnpushedCommitCount(count: number, t: Translate = translate): string {
  return t(
    'auto.components.workspace.cleanup.candidateRow.unpushedCommitsCount',
    'Unpushed commits: {{value0}}',
    { value0: count }
  )
}

export function getUncommittedChangesLabel(t: Translate = translate): string {
  return t(
    'auto.components.workspace.cleanup.candidateRow.uncommittedChanges',
    'Uncommitted changes'
  )
}

export function getGitStatusUnknownLabel(t: Translate = translate): string {
  return t('auto.components.workspace.cleanup.candidateRow.gitStatusUnknown', 'Git status unknown')
}

export function formatWorkspaceCleanupContextDetail(
  kind: ContextDetailKind,
  count: number,
  t: Translate = translate
): string {
  switch (kind) {
    case 'terminal':
      return t(
        'auto.components.workspace.cleanup.candidateRow.terminalTabsCount',
        'Terminal tabs: {{value0}}',
        { value0: count }
      )
    case 'editor':
      return t(
        'auto.components.workspace.cleanup.candidateRow.editorTabsCount',
        'Editor tabs: {{value0}}',
        { value0: count }
      )
    case 'browser':
      return t(
        'auto.components.workspace.cleanup.candidateRow.browserTabsCount',
        'Browser tabs: {{value0}}',
        { value0: count }
      )
    case 'diff':
      return t(
        'auto.components.workspace.cleanup.candidateRow.diffNotesCount',
        'Diff notes: {{value0}}',
        { value0: count }
      )
    case 'agent':
      return t(
        'auto.components.workspace.cleanup.candidateRow.completedAgentsCount',
        'Completed agents: {{value0}}',
        { value0: count }
      )
  }
}
