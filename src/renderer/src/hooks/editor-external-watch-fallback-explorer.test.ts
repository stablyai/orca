import { expect, it } from 'vitest'
import { makeFolderWorkspace } from '@/store/slices/worktrees-slice-test-fixtures'
import { getDefaultSettings } from '../../../shared/constants'
import {
  selectEditorExternalWatchTargets,
  type EditorExternalWatchTargetState
} from './editor-external-watch-targets'

function makeState(
  overrides: Partial<EditorExternalWatchTargetState> = {}
): EditorExternalWatchTargetState {
  return {
    settings: getDefaultSettings('/home/me'),
    openFiles: [],
    activeWorktreeId: 'folder:remote-folder',
    repos: [],
    worktreesByRepo: {},
    folderWorkspaces: [
      makeFolderWorkspace({
        id: 'remote-folder',
        folderPath: '/srv/folder',
        executionHostId: 'runtime:env-a'
      })
    ],
    projectGroups: [],
    rightSidebarOpen: true,
    // Source Control is git-only, so a folder workspace renders Explorer as the fallback.
    rightSidebarTab: 'source-control',
    rightSidebarExplorerView: 'files',
    gitStatusHugeByWorktree: {},
    sshConnectionStates: new Map(),
    ...overrides
  }
}

it('watches a remote folder whose Explorer is shown as the fallback for a hidden stored tab', () => {
  const { targets } = selectEditorExternalWatchTargets(
    makeState({ rightSidebarEffectiveTab: 'explorer' })
  )
  expect(targets).toEqual([
    expect.objectContaining({
      worktreeId: 'folder:remote-folder',
      worktreePath: '/srv/folder',
      runtimeEnvironmentId: 'env-a'
    })
  ])
})

it('drops the sidebar watch when the shown tab is not Explorer even if the stored tab is', () => {
  const { targets } = selectEditorExternalWatchTargets(
    makeState({ rightSidebarTab: 'explorer', rightSidebarEffectiveTab: 'workspaces' })
  )
  expect(targets).toEqual([])
})

it('falls back to the stored tab before the sidebar publishes what it shows', () => {
  const { targets } = selectEditorExternalWatchTargets(
    makeState({ rightSidebarTab: 'explorer', rightSidebarEffectiveTab: null })
  )
  expect(targets.map((target) => target.runtimeEnvironmentId)).toEqual(['env-a'])
})
