import { beforeEach, describe, expect, it, vi } from 'vitest'
import { posix as pathPosix } from 'node:path'
import type { BrowserPage, BrowserWorkspace } from '../../../shared/browser-workspace-types'
import type { Tab } from '../../../shared/tab-types'
import type { OpenFile } from '../store/slices/editor'
import { applyWebSessionTabsSnapshot, type WebSessionTabsSyncState } from './web-session-tabs-sync'
import {
  ENV,
  HOST_SURFACE_ID,
  LEAF_ID,
  NOW,
  WT,
  makeSnapshot,
  makeState,
  resetWebSessionTabsSyncTestState
} from './web-session-tabs-sync-test-harness'

vi.mock('../store', () => ({
  useAppStore: {
    setState: vi.fn()
  }
}))

describe('applyWebSessionTabsSnapshot', () => {
  beforeEach(resetWebSessionTabsSyncTestState)

  it('hydrates active host markdown tabs as remote editor tabs', () => {
    const patch = applyWebSessionTabsSnapshot(
      makeState(),
      makeSnapshot(
        [
          {
            type: 'terminal',
            id: HOST_SURFACE_ID,
            title: 'host shell',
            parentTabId: 'host-tab-1',
            leafId: LEAF_ID,
            isActive: false,
            status: 'ready',
            terminal: 'terminal-1'
          },
          {
            type: 'markdown',
            id: 'host-readme-unified',
            title: 'README.md',
            filePath: '/repo/README.md',
            relativePath: 'README.md',
            language: 'markdown',
            mode: 'edit',
            isDirty: true,
            isActive: true,
            sourceFileId: '/repo/README.md',
            sourceFilePath: '/repo/README.md',
            sourceRelativePath: 'README.md',
            documentVersion: 'draft:1',
            color: '#16a34a',
            isPinned: true
          }
        ],
        { activeTabId: 'host-readme-unified', activeTabType: 'markdown' }
      ),
      ENV,
      NOW
    ) as Partial<WebSessionTabsSyncState>

    const terminalId = patch.tabsByWorktree?.[WT]?.[0]?.id
    expect(patch.openFiles).toMatchObject([
      {
        id: '/repo/README.md',
        filePath: '/repo/README.md',
        relativePath: 'README.md',
        worktreeId: WT,
        language: 'markdown',
        isDirty: true,
        runtimeEnvironmentId: ENV,
        mode: 'edit'
      }
    ])
    expect(patch.unifiedTabsByWorktree?.[WT]).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'host-readme-unified',
          entityId: '/repo/README.md',
          contentType: 'editor',
          label: 'README.md',
          color: '#16a34a',
          isPinned: true
        })
      ])
    )
    expect(patch.groupsByWorktree?.[WT]?.[0]).toMatchObject({
      activeTabId: 'host-readme-unified',
      tabOrder: [terminalId, 'host-readme-unified']
    })
    expect(patch.activeFileId).toBe('/repo/README.md')
    expect(patch.activeFileIdByWorktree?.[WT]).toBe('/repo/README.md')
    expect(patch.activeTabType).toBe('editor')
    expect(patch.activeTabTypeByWorktree?.[WT]).toBe('editor')
  })

  it('applies host-cleared browser and editor tab props over existing mirrored state', () => {
    const workspace: BrowserWorkspace = {
      id: 'local-browser-workspace',
      worktreeId: WT,
      activePageId: 'local-browser-page',
      pageIds: ['local-browser-page'],
      url: 'https://example.com/',
      title: 'Example Domain',
      loading: false,
      faviconUrl: null,
      canGoBack: false,
      canGoForward: false,
      loadError: null,
      createdAt: NOW - 10
    }
    const page: BrowserPage = {
      id: 'local-browser-page',
      workspaceId: workspace.id,
      worktreeId: WT,
      url: 'https://example.com/',
      title: 'Example Domain',
      loading: false,
      faviconUrl: null,
      canGoBack: false,
      canGoForward: false,
      loadError: null,
      createdAt: NOW - 10
    }
    const readmePath = pathPosix.join('/repo', 'README.md')
    const file: OpenFile = {
      id: readmePath,
      filePath: readmePath,
      relativePath: 'README.md',
      worktreeId: WT,
      language: 'markdown',
      isDirty: false,
      runtimeEnvironmentId: ENV,
      mode: 'edit'
    }
    const existingTabs: Tab[] = [
      {
        id: 'local-browser-unified',
        entityId: workspace.id,
        groupId: 'host-group-1',
        worktreeId: WT,
        contentType: 'browser',
        label: 'Example Domain',
        customLabel: null,
        color: '#3b82f6',
        sortOrder: 0,
        createdAt: NOW - 10,
        isPreview: false,
        isPinned: true
      },
      {
        id: 'host-readme-unified',
        entityId: file.id,
        groupId: 'host-group-1',
        worktreeId: WT,
        contentType: 'editor',
        label: 'README.md',
        customLabel: null,
        color: '#16a34a',
        sortOrder: 1,
        createdAt: NOW - 9,
        isPreview: false,
        isPinned: true
      }
    ]

    const patch = applyWebSessionTabsSnapshot(
      makeState({
        browserTabsByWorktree: { [WT]: [workspace] },
        browserPagesByWorkspace: { [workspace.id]: [page] },
        remoteBrowserPageHandlesByPageId: {
          [page.id]: { environmentId: ENV, remotePageId: 'host-browser-page' }
        },
        browserCertificateFailuresByPageId: {
          [page.id]: {
            challengeId: 'stale-challenge',
            browserPageId: 'host-browser-page',
            errorCode: -202,
            error: 'ERR_CERT_AUTHORITY_INVALID',
            origin: 'https://localhost:3443',
            displayHost: 'localhost:3443',
            canProceed: true,
            observedAt: 100
          }
        },
        openFiles: [file],
        unifiedTabsByWorktree: { [WT]: existingTabs }
      }),
      makeSnapshot(
        [
          {
            type: 'browser',
            id: 'host-browser-unified',
            title: 'Example Domain',
            browserWorkspaceId: 'host-browser-workspace',
            browserPageId: 'host-browser-page',
            url: 'https://example.com/',
            loading: false,
            canGoBack: false,
            canGoForward: false,
            color: null,
            isPinned: false,
            isActive: false
          },
          {
            type: 'markdown',
            id: 'host-readme-unified',
            title: 'README.md',
            filePath: readmePath,
            relativePath: 'README.md',
            language: 'markdown',
            mode: 'edit',
            isDirty: false,
            isActive: true,
            sourceFileId: readmePath,
            sourceFilePath: readmePath,
            sourceRelativePath: 'README.md',
            documentVersion: `file:${readmePath}`,
            color: null,
            isPinned: false
          }
        ],
        { activeTabId: 'host-readme-unified', activeTabType: 'markdown' }
      ),
      ENV,
      NOW
    ) as Partial<WebSessionTabsSyncState>

    expect(patch.unifiedTabsByWorktree?.[WT]).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'local-browser-unified',
          color: null,
          isPinned: false
        }),
        expect.objectContaining({
          id: 'host-readme-unified',
          color: null,
          isPinned: false
        })
      ])
    )
    // Why: older runtimes omit this transient field. Omission must clear an
    // earlier challenge instead of leaving an unsafe action wired to stale RPC input.
    expect(patch.browserCertificateFailuresByPageId).toEqual({})
  })

  it('uses local markdown preview file ids while preserving the host unified tab id', () => {
    const patch = applyWebSessionTabsSnapshot(
      makeState(),
      makeSnapshot(
        [
          {
            type: 'markdown',
            id: 'host-preview-unified',
            title: 'README.md',
            filePath: '/repo/README.md',
            relativePath: 'README.md',
            language: 'markdown',
            mode: 'markdown-preview',
            isDirty: false,
            isActive: true,
            sourceFileId: '/repo/README.md',
            sourceFilePath: '/repo/README.md',
            sourceRelativePath: 'README.md',
            documentVersion: 'file:/repo/README.md'
          }
        ],
        { activeTabId: 'host-preview-unified', activeTabType: 'markdown' }
      ),
      ENV,
      NOW
    ) as Partial<WebSessionTabsSyncState>

    expect(patch.openFiles).toMatchObject([
      {
        id: 'markdown-preview::/repo/README.md',
        filePath: '/repo/README.md',
        markdownPreviewSourceFileId: '/repo/README.md',
        mode: 'markdown-preview'
      }
    ])
    expect(patch.unifiedTabsByWorktree?.[WT]).toMatchObject([
      {
        id: 'host-preview-unified',
        entityId: 'markdown-preview::/repo/README.md',
        contentType: 'editor'
      }
    ])
    expect(patch.activeFileId).toBe('markdown-preview::/repo/README.md')
  })

  it('removes mirrored editor tabs when the host closes the file', () => {
    const hydratedPatch = applyWebSessionTabsSnapshot(
      makeState(),
      makeSnapshot(
        [
          {
            type: 'markdown',
            id: 'host-readme-unified',
            title: 'README.md',
            filePath: '/repo/README.md',
            relativePath: 'README.md',
            language: 'markdown',
            mode: 'edit',
            isDirty: false,
            isActive: true,
            sourceFileId: '/repo/README.md',
            sourceFilePath: '/repo/README.md',
            sourceRelativePath: 'README.md',
            documentVersion: 'file:/repo/README.md'
          }
        ],
        { activeTabId: 'host-readme-unified', activeTabType: 'markdown' }
      ),
      ENV,
      NOW
    ) as Partial<WebSessionTabsSyncState>
    const hydratedState = { ...makeState(), ...hydratedPatch } as WebSessionTabsSyncState

    expect(hydratedState.openFiles[0]).toMatchObject({
      id: '/repo/README.md',
      mirroredFromRuntimeSession: true
    })
    expect(hydratedState.unifiedTabsByWorktree[WT]?.[0]).toMatchObject({
      id: 'host-readme-unified',
      entityId: '/repo/README.md'
    })

    const patch = applyWebSessionTabsSnapshot(
      hydratedState,
      makeSnapshot([], { activeTabId: null, activeTabType: null }),
      ENV,
      NOW
    ) as Partial<WebSessionTabsSyncState>

    expect(patch.openFiles).toEqual([])
    expect(patch.unifiedTabsByWorktree?.[WT]).toBeUndefined()
    expect(patch.groupsByWorktree?.[WT]).toBeUndefined()
    expect(patch.activeFileId).toBeNull()
    expect(patch.activeFileIdByWorktree?.[WT]).toBeNull()
    expect(patch.activeTabType).toBe('terminal')
    expect(patch.activeTabTypeByWorktree?.[WT]).toBe('terminal')
  })

  it('keeps locally opened editor tabs when the host snapshot omits them', () => {
    // Why: web file clicks open tabs locally with no host counterpart. A host
    // snapshot that does not list the file must not cull the user's own tab.
    const openFile: OpenFile = {
      id: '/repo/local-notes.md',
      filePath: '/repo/local-notes.md',
      relativePath: 'local-notes.md',
      worktreeId: WT,
      language: 'markdown',
      isDirty: false,
      runtimeEnvironmentId: ENV,
      mode: 'edit'
    }
    const unifiedTab: Tab = {
      id: 'local-notes-unified',
      entityId: openFile.id,
      groupId: 'local-group',
      worktreeId: WT,
      contentType: 'editor',
      label: 'local-notes.md',
      customLabel: null,
      color: null,
      sortOrder: 0,
      createdAt: NOW - 10,
      isPreview: false,
      isPinned: false
    }

    const patch = applyWebSessionTabsSnapshot(
      makeState({
        activeFileId: openFile.id,
        activeFileIdByWorktree: { [WT]: openFile.id },
        activeTabType: 'editor',
        activeTabTypeByWorktree: { [WT]: 'editor' },
        openFiles: [openFile],
        unifiedTabsByWorktree: { [WT]: [unifiedTab] },
        groupsByWorktree: {
          [WT]: [
            {
              id: 'local-group',
              worktreeId: WT,
              activeTabId: unifiedTab.id,
              tabOrder: [unifiedTab.id],
              recentTabIds: [unifiedTab.id]
            }
          ]
        }
      }),
      makeSnapshot([], { activeTabId: null, activeTabType: null }),
      ENV,
      NOW
    ) as Partial<WebSessionTabsSyncState>

    // The locally opened file and its tab survive the host snapshot sync. Nothing
    // is culled, so the sync leaves editor ownership and selection state alone.
    expect(patch.openFiles).toBeUndefined()
    expect(patch.unifiedTabsByWorktree?.[WT]).toBeUndefined()
    expect(patch.groupsByWorktree?.[WT]).toBeUndefined()
    expect(patch.activeFileId).toBeUndefined()
    expect(patch.activeFileIdByWorktree).toBeUndefined()
    expect(patch.activeTabType).toBeUndefined()
    expect(patch.activeTabTypeByWorktree).toBeUndefined()
  })

  describe('client dirtiness across a host republish (#21392)', () => {
    const notesPath = '/repo/NOTES.md'
    const mirroredNotes = (isDirty: boolean): OpenFile => ({
      id: notesPath,
      filePath: notesPath,
      relativePath: 'NOTES.md',
      worktreeId: WT,
      language: 'markdown',
      isDirty,
      runtimeEnvironmentId: ENV,
      mode: 'edit',
      mirroredFromRuntimeSession: true
    })
    const notesUnifiedTab: Tab = {
      id: 'host-notes-unified',
      entityId: notesPath,
      groupId: 'host-group-1',
      worktreeId: WT,
      contentType: 'editor',
      label: 'NOTES.md',
      customLabel: null,
      color: null,
      sortOrder: 0,
      createdAt: NOW - 10,
      isPreview: false,
      isPinned: false
    }
    // The host republishes the same tab with its own store's flag: not dirty.
    const hostCleanSnapshot = () =>
      makeSnapshot(
        [
          {
            type: 'markdown',
            id: 'host-notes-unified',
            title: 'NOTES.md',
            filePath: notesPath,
            relativePath: 'NOTES.md',
            language: 'markdown',
            mode: 'edit',
            isDirty: false,
            isActive: true,
            sourceFileId: notesPath,
            sourceFilePath: notesPath,
            sourceRelativePath: 'NOTES.md',
            documentVersion: `file:${notesPath}`,
            color: null,
            isPinned: false
          }
        ],
        { activeTabId: 'host-notes-unified', activeTabType: 'markdown' }
      )

    it('keeps a client-dirty mirrored file dirty when the host republishes isDirty: false', () => {
      // Why: the host never learns about client edits, so its flag would otherwise erase the
      // client's, and the tab strip would close the tab with no prompt while the draft lives.
      const patch = applyWebSessionTabsSnapshot(
        makeState({
          openFiles: [mirroredNotes(true)],
          editorDrafts: { [notesPath]: '# unsaved client edits' },
          unifiedTabsByWorktree: { [WT]: [notesUnifiedTab] }
        }),
        hostCleanSnapshot(),
        ENV,
        NOW
      )

      // No open-file change means the dirty flag survived exactly as it was.
      expect(patch.openFiles).toBeUndefined()
    })

    it('follows a host-side save when the client holds no draft', () => {
      // Why: a dirty flag with no client draft came from an earlier host snapshot; keeping it
      // would strand the tab as dirty after the host saved.
      const patch = applyWebSessionTabsSnapshot(
        makeState({
          openFiles: [mirroredNotes(true)],
          editorDrafts: {},
          unifiedTabsByWorktree: { [WT]: [notesUnifiedTab] }
        }),
        hostCleanSnapshot(),
        ENV,
        NOW
      )

      expect(patch.openFiles).toMatchObject([{ id: notesPath, isDirty: false }])
    })

    it('does not invent dirtiness from a draft the client already reverted', () => {
      // Why: a lingering draft with isDirty false means the user typed and undid; the tab is
      // clean and must not start prompting on close.
      const patch = applyWebSessionTabsSnapshot(
        makeState({
          openFiles: [mirroredNotes(false)],
          editorDrafts: { [notesPath]: 'same as disk' },
          unifiedTabsByWorktree: { [WT]: [notesUnifiedTab] }
        }),
        hostCleanSnapshot(),
        ENV,
        NOW
      )

      expect(patch.openFiles).toBeUndefined()
    })
  })
})
