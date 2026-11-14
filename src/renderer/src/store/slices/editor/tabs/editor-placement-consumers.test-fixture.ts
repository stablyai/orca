import { useAppStore } from '@/store/index'
import { makeOpenFile } from '../types/open-file.test-fixture'
import { makeTabGroup, makeUnifiedTab } from '../../tabs/tab-group.test-fixture'
import { makeWorktree } from '../../worktrees/worktree.test-fixture'
import { TEST_REPO } from '../../../repos/repo.test-fixture'
import {
  makeFolderWorkspace,
  makeProjectGroup
} from '@/components/sidebar/workspace-creation/folder/folder-workspace-composer-submit-fixtures'
import type { OpenFile } from '../types/open-file'
import { createGlobalSettingsFixture } from '../../../../../../shared/global-settings-test-fixture'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../../../../shared/layout-owner-switch'
import { drawTabsFromMain } from '../../tabs/tabs-drawn-from-main.test-fixture'
import { layoutApplyTestTransport } from '@/runtime/workspace-layout/testing/layout-apply-test-transport.test-fixture'
import { beginPendingTab } from '@/runtime/workspace-layout/intents/layout-owner-pending-tabs'
import { newGroupSplitOf } from '@/runtime/workspace-layout/commands/layout-owner-new-group-split'
import { editorTabContent } from './editor-tab-open-through-layout-owner'
import { isEditorTabContentType } from './editor-tab-content-type'
import { markHydratedBrowserPageHandles } from '../../browser/hosts/browser-initialization-presentation-ownership'

export const EDITOR_OWNER = 'repo1::/repo'
export const EDITOR_PLACEMENT = 'folder:feature'

export function seedEditorPlacementConsumers(
  overrides: Partial<OpenFile> = {},
  ownerPlacement = true
) {
  const initialState = useAppStore.getInitialState()
  useAppStore.setState(
    {
      ...initialState,
      remoteBrowserPageHandlesByPageId: markHydratedBrowserPageHandles({
        ...initialState.remoteBrowserPageHandlesByPageId
      })
    },
    true
  )
  const file = makeOpenFile({
    id: overrides.mode === 'edit' ? (overrides.filePath ?? '/repo/notes.md') : 'content',
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
    settings: createGlobalSettingsFixture({
      editorAutoSave: false,
      editorPreviewTabsEnabled: false
    }),
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
      [EDITOR_PLACEMENT]: [file.id],
      [EDITOR_OWNER]: owned.map((tab) => tab.entityId)
    }
  })
  return file
}

/** Live views are opened after main starts; restart persistence intentionally omits these placements. */
export async function drawEditorPlacementConsumers() {
  if (!ORCA_LAYOUT_OWNER_IS_MAIN) {
    return drawTabsFromMain(useAppStore)
  }
  const seeded = useAppStore.getState()
  useAppStore.setState({
    openFiles: [],
    activeFileId: null,
    unifiedTabsByWorktree: {},
    groupsByWorktree: {},
    layoutByWorktree: {},
    activeGroupIdByWorktree: {},
    tabBarOrderByWorktree: {}
  })
  const main = await drawTabsFromMain(useAppStore)
  const tabs = Object.values(seeded.unifiedTabsByWorktree).flat()
  const settlements = tabs.map((tab) =>
    beginPendingTab(tab.id, tab.worktreeId, tab.entityId, { kind: 'open', groupId: tab.groupId })
  )
  useAppStore.setState({
    openFiles: seeded.openFiles,
    unifiedTabsByWorktree: Object.fromEntries(
      Object.keys(seeded.unifiedTabsByWorktree).map((key) => [key, []])
    )
  })
  try {
    for (const tab of tabs) {
      const file = seeded.openFiles.find((entry) => entry.id === tab.entityId)
      if (!file || !isEditorTabContentType(tab.contentType)) {
        throw new Error('Expected an editor placement fixture')
      }
      const reply = await layoutApplyTestTransport.call({
        command: {
          type: 'openEditorTab',
          workspace: tab.worktreeId,
          tabId: tab.id,
          fileId: tab.entityId,
          contentType: tab.contentType,
          groupId: tab.groupId,
          ...editorTabContent(file, tab.worktreeId),
          ...newGroupSplitOf(seeded, tab.worktreeId, tab.groupId, tab.id)
        }
      })
      if (!reply.ok || reply.result.tabId !== tab.id) {
        throw new Error('Main did not open the requested fixture placement')
      }
      await main.settle()
    }
    const group = seeded.groupsByWorktree[EDITOR_PLACEMENT]?.find(
      (entry) => entry.id === seeded.activeGroupIdByWorktree[EDITOR_PLACEMENT]
    )
    if (group?.activeTabId) {
      useAppStore.getState().activateTab(group.activeTabId)
    }
    await main.settle()
    return main
  } catch (error) {
    main.close()
    throw error
  } finally {
    settlements.forEach((settle, index) => settle(tabs[index]!.id))
  }
}
