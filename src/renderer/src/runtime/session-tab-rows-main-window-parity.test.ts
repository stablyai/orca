// Diff and markdown-preview rows: main's projection of its layout model (the window's session plus
// the editor views the window publishes) must equal the rows the window builds for the same tabs.

import { describe, expect, it, vi } from 'vitest'
import { LOCAL_EXECUTION_HOST_ID } from '../../../shared/execution-host'
import type { RuntimeMobileSessionTabsSnapshot } from '../../../shared/runtime-session-contracts'
import type { LayoutEditorView } from '../../../shared/workspace-layout/layout-editor-view'
import { projectSessionTabs } from '../../../shared/workspace-layout/old-client/old-client-session-tab-rows'
import { loadWorkspaceLayoutWithoutReport } from '../../../shared/workspace-layout/workspace-layout-load'
import { nameBasedLoadContext } from '../../../shared/workspace-layout/workspace-layout-minted-ids'
import {
  addWorkspace,
  emptySession,
  GIT_KEY
} from '../../../shared/workspace-layout/workspace-layout-session.test-fixture'
import { ownedEditorFileId } from '../../../shared/workspace-session-pane-ownership'
import type { OpenFile } from '../store/slices/editor'
import { layoutEditorViewOfOpenFile } from '../store/slices/editor/tabs/open-file-layout-view'
import { buildMobileSessionTabSnapshots } from './sync-runtime-graph/mobile-session-snapshots'
import { makeState } from './sync-runtime-graph-test-harness'

// Main's projection runs on the layout-owner path only.
vi.mock('../../../shared/layout-owner-switch', () => ({ ORCA_LAYOUT_OWNER_IS_MAIN: true }))

const README = '/Users/dev/orca/README.md'
const SERVER_DOC = '/srv/app/GUIDE.md'
const SERVER_DOC_ID = ownedEditorFileId(SERVER_DOC, GIT_KEY, 'env-1')

const files: OpenFile[] = [
  {
    id: README,
    filePath: README,
    relativePath: 'README.md',
    worktreeId: GIT_KEY,
    language: 'markdown',
    mode: 'edit',
    isDirty: true
  },
  {
    id: SERVER_DOC_ID,
    filePath: SERVER_DOC,
    relativePath: 'GUIDE.md',
    worktreeId: GIT_KEY,
    language: 'markdown',
    runtimeEnvironmentId: 'env-1',
    mode: 'edit',
    isDirty: false
  },
  {
    id: `markdown-preview::${README}`,
    filePath: README,
    relativePath: 'README.md',
    worktreeId: GIT_KEY,
    language: 'markdown',
    mode: 'markdown-preview',
    markdownPreviewSourceFileId: README,
    isDirty: false
  },
  {
    id: `markdown-preview::${SERVER_DOC_ID}`,
    filePath: SERVER_DOC,
    relativePath: 'GUIDE.md',
    worktreeId: GIT_KEY,
    language: 'markdown',
    runtimeEnvironmentId: 'env-1',
    mode: 'markdown-preview',
    markdownPreviewSourceFileId: SERVER_DOC_ID,
    isDirty: false
  },
  // Its source tab is closed: the preview is its own source.
  {
    id: 'markdown-preview::/Users/dev/orca/CHANGELOG.md',
    filePath: '/Users/dev/orca/CHANGELOG.md',
    relativePath: 'CHANGELOG.md',
    worktreeId: GIT_KEY,
    language: 'markdown',
    mode: 'markdown-preview',
    markdownPreviewSourceFileId: '/Users/dev/orca/CHANGELOG.md',
    isDirty: false
  },
  {
    id: `${GIT_KEY}::diff::unstaged::src/app.ts`,
    filePath: '/Users/dev/orca/src/app.ts',
    relativePath: 'src/app.ts',
    worktreeId: GIT_KEY,
    language: 'typescript',
    mode: 'diff',
    diffSource: 'unstaged',
    isDirty: false
  },
  {
    id: `${GIT_KEY}::diff::branch::src/lib.ts`,
    filePath: '/Users/dev/orca/src/lib.ts',
    relativePath: 'src/lib.ts',
    worktreeId: GIT_KEY,
    language: 'typescript',
    mode: 'diff',
    diffSource: 'branch',
    isDirty: false
  },
  {
    id: `${GIT_KEY}::all-diffs::uncommitted`,
    filePath: '/Users/dev/orca',
    relativePath: 'All Changes',
    worktreeId: GIT_KEY,
    language: 'plaintext',
    mode: 'diff',
    diffSource: 'combined-all',
    isDirty: false
  }
]

const tabIdOf = (file: OpenFile): string => `tab:${file.id}`

/** The window's session for `files`, one tab each in one group, and the views it publishes. */
function scenario(activeFileId: string) {
  const session = addWorkspace(emptySession(), GIT_KEY, [
    {
      id: 'group-1',
      activeTabId: tabIdOf(files.find((file) => file.id === activeFileId)!),
      tabs: files.map((file) => ({
        id: tabIdOf(file),
        entityId: file.id,
        kind: file.mode === 'diff' ? ('diff' as const) : ('editor' as const),
        entry: { color: file.mode === 'diff' ? '#00ff00' : null }
      }))
    }
  ])
  const editFiles = files.filter((file) => file.mode === 'edit')
  session.openFilesByWorktree = {
    [GIT_KEY]: editFiles.map((file) => ({
      filePath: file.filePath,
      relativePath: file.relativePath,
      worktreeId: GIT_KEY,
      language: file.language,
      ...(file.runtimeEnvironmentId ? { runtimeEnvironmentId: file.runtimeEnvironmentId } : {}),
      ...(file.isDirty ? { dirtyDraftContent: '# draft' } : {})
    }))
  }
  const views: Record<string, LayoutEditorView> = {}
  for (const file of files) {
    const view = layoutEditorViewOfOpenFile(file)
    if (view) {
      views[tabIdOf(file)] = view
    }
  }
  const windowState = makeState({
    openFiles: files,
    unifiedTabsByWorktree: session.unifiedTabs!,
    groupsByWorktree: session.tabGroups!,
    layoutByWorktree: session.tabGroupLayouts!,
    activeGroupIdByWorktree: { [GIT_KEY]: 'group-1' },
    activeFileId,
    activeFileIdByWorktree: { [GIT_KEY]: activeFileId },
    activeTabType: 'editor',
    activeTabTypeByWorktree: { [GIT_KEY]: 'editor' }
  })
  const loaded = loadWorkspaceLayoutWithoutReport(LOCAL_EXECUTION_HOST_ID, session, {
    ...nameBasedLoadContext(),
    editorViewsOf: (key) => (key === GIT_KEY ? views : undefined)
  })
  const main = projectSessionTabs(
    GIT_KEY,
    loaded.layout.workspaces[GIT_KEY]!,
    loaded.desktopView,
    loaded.facts,
    false
  )
  const window = buildMobileSessionTabSnapshots(windowState).find(
    (snapshot) => snapshot.worktree === GIT_KEY
  )!
  return { main, window }
}

/** What both sides publish, minus what only the runtime stamps. */
function published(snapshot: Pick<RuntimeMobileSessionTabsSnapshot, 'tabs' | 'tabGroups'>) {
  return { tabs: snapshot.tabs, tabGroups: snapshot.tabGroups }
}

describe("main's diff and markdown-preview rows", () => {
  it.each([
    ['a diff', `${GIT_KEY}::diff::unstaged::src/app.ts`],
    ['a markdown preview', `markdown-preview::${README}`]
  ])("equal the window's rows with %s active", (_label, activeFileId) => {
    const { main, window } = scenario(activeFileId)
    // Every file but the combined diff, which neither side lists.
    expect(window.tabs).toHaveLength(files.length - 1)
    expect(published(main)).toEqual(published(window))
    expect(main.activeTabId).toBe(window.activeTabId)
    expect(main.activeTabType).toBe(window.activeTabType)
  })

  it('links a preview to its source by the open-file id, owned ids included', () => {
    const { main } = scenario(`markdown-preview::${README}`)
    const previews = main.tabs.filter((tab) => tab.type === 'markdown' && tab.mode !== 'edit')
    expect(
      previews.map((tab) => tab.type === 'markdown' && [tab.sourceFileId, tab.isDirty])
    ).toEqual([
      [README, true],
      [SERVER_DOC_ID, false],
      ['markdown-preview::/Users/dev/orca/CHANGELOG.md', false]
    ])
  })
})
