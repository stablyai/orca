import { defineFixture } from '../../../../component-fixtures/component-fixture'
import { FileExplorerToolbar } from './FileExplorerToolbar'
import type { FileExplorerTitle } from './file-explorer-title'

function Toolbar({ title }: { title: FileExplorerTitle }): React.JSX.Element {
  return (
    <FileExplorerToolbar
      title={title}
      worktreePath="/repo/.claude/worktrees/fix-login"
      refresh={{ isRefreshing: false, showRefreshSpinner: false, handleRefresh: () => {} }}
      canRefresh
      canCollapseAll
      onCollapseAll={() => {}}
      showGitIgnoredFilesToggle
      showGitIgnoredFiles={false}
      onToggleGitIgnoredFiles={() => {}}
      showDotfiles
      onToggleDotfiles={() => {}}
    />
  )
}

// A folder project, and every project before the worktree was named.
export const projectOnly = defineFixture({
  width: 300,
  render: () => <Toolbar title={{ repoName: 'orca', worktreeName: null }} />
})

export const worktree = defineFixture({
  width: 300,
  render: () => <Toolbar title={{ repoName: 'orca', worktreeName: 'fix-login' }} />
})

export const longNames = defineFixture({
  width: 300,
  render: () => (
    <Toolbar
      title={{
        repoName: 'orca-desktop-monorepo',
        worktreeName: 'sotashimozono/file-explorer-worktree-title'
      }}
    />
  )
})

// A long project with a short worktree keeps as much of the project name as fits.
export const longProject = defineFixture({
  width: 300,
  render: () => <Toolbar title={{ repoName: 'orca-e2e-repo-ILyZiY', worktreeName: 'master' }} />
})
