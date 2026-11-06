import { useAppStore } from '@/store'
import { makeOpenFile, makeTabGroup, makeUnifiedTab } from './store-session-test-harness'
import { makeWorktree, TEST_REPO } from './worktrees-slice-test-fixtures'
import {
  makeFolderWorkspace,
  makeProjectGroup
} from '@/components/sidebar/workspace-creation/folder/folder-workspace-composer-submit-fixtures'
import type { OpenFile } from './editor'

export const EDITOR_OWNER = 'repo1::/repo'
export const EDITOR_PLACEMENT = 'folder:feature'

export function seedEditorPlacementConsumers(
  overrides: Partial<OpenFile> = {},
  ownerPlacement = true
) {
  useAppStore.setState(useAppStore.getInitialState(), true)
  const file = makeOpenFile({
    id: 'content',
    filePath: '/repo/notes.md',
    relativePath: 'notes.md',
    worktreeId: EDITOR_OWNER,
    mode: 'diff',
    diffSource: 'unstaged',
    language: 'markdown',
    runtimeEnvironmentId: null,
    ...overrides
  })
  const tab = (id: string, worktreeId: string, groupId: string) =>
    makeUnifiedTab({
      id,
      entityId: file.id,
      worktreeId,
      groupId,
      contentType: file.mode === 'edit' ? 'editor' : 'diff',
      executionHostId: 'local'
    })
  const placed = [
    tab('x-source-tab', EDITOR_PLACEMENT, 'x-source'),
    tab('x-other-tab', EDITOR_PLACEMENT, 'x-other')
  ]
  const owned = ownerPlacement ? [tab('y-tab', EDITOR_OWNER, 'y-group')] : []
  const groups = (tabs: typeof placed) =>
    tabs.map((tab) =>
      makeTabGroup({
        id: tab.groupId,
        worktreeId: tab.worktreeId,
        activeTabId: tab.id,
        tabOrder: [tab.id]
      })
    )
  useAppStore.setState({
    activeWorktreeId: EDITOR_PLACEMENT,
    activeWorkspaceKey: EDITOR_PLACEMENT,
    activeWorkspaceExecutionHostId: 'local',
    activeFileId: file.id,
    activeTabType: 'editor',
    repos: [{ ...TEST_REPO, path: '/repo', executionHostId: 'local' }],
    worktreesByRepo: {
      repo1: [makeWorktree({ id: EDITOR_OWNER, repoId: 'repo1', path: '/repo', hostId: 'local' })]
    },
    folderWorkspaces: [
      makeFolderWorkspace({ id: 'feature', folderPath: '/folder', executionHostId: 'local' })
    ],
    projectGroups: [makeProjectGroup()],
    runtimeEnvironmentCatalogHydrated: true,
    settings: {
      ...useAppStore.getState().settings,
      editorAutoSave: false,
      editorPreviewTabsEnabled: false
    },
    openFiles: [file],
    unifiedTabsByWorktree: { [EDITOR_PLACEMENT]: placed, [EDITOR_OWNER]: owned },
    groupsByWorktree: { [EDITOR_PLACEMENT]: groups(placed), [EDITOR_OWNER]: groups(owned) },
    activeGroupIdByWorktree: { [EDITOR_PLACEMENT]: 'x-other', [EDITOR_OWNER]: 'y-group' },
    layoutByWorktree: {
      [EDITOR_PLACEMENT]: {
        type: 'split',
        direction: 'horizontal',
        first: { type: 'leaf', groupId: 'x-source' },
        second: { type: 'leaf', groupId: 'x-other' }
      },
      ...(ownerPlacement ? { [EDITOR_OWNER]: { type: 'leaf' as const, groupId: 'y-group' } } : {})
    },
    tabBarOrderByWorktree: {
      [EDITOR_PLACEMENT]: ['x-source-tab', 'x-other-tab'],
      [EDITOR_OWNER]: owned.map((tab) => tab.id)
    }
  })
  return file
}
