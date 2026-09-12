import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  hashMarkdownContent,
  MOBILE_MARKDOWN_EDIT_MAX_BYTES
} from '../../../shared/mobile-markdown-document'
import { attachEditorAutosaveController } from '../components/editor/editor-autosave-controller'
import { registerPendingEditorFlush } from '../components/editor/editor-pending-flush'
import { useAppStore } from '../store'
import { attachMobileMarkdownBridge } from './mobile-markdown-bridge'
import {
  cleanupMobileMarkdownBridgeHarness,
  openMarkdownFile,
  resetEditorState,
  sendRequest,
  setupWindow
} from './mobile-markdown-bridge-test-harness'

vi.mock('@/lib/connection-context', () => ({
  getConnectionIdForFile: () => null
}))

function activateTerminalSplitBesideMarkdown(): {
  markdownGroupId: string
  terminalGroupId: string
} {
  const state = useAppStore.getState()
  const markdownGroupId = state.unifiedTabsByWorktree['wt-1']?.find(
    (tab) => tab.id === 'tab-md'
  )?.groupId
  if (!markdownGroupId) {
    throw new Error('Missing Markdown group')
  }
  useAppStore.setState((current) => ({
    tabsByWorktree: {
      ...current.tabsByWorktree,
      'wt-1': [
        {
          id: 'terminal-tab',
          ptyId: null,
          worktreeId: 'wt-1',
          title: 'Terminal',
          customTitle: null,
          color: null,
          sortOrder: 1,
          createdAt: 2
        }
      ]
    }
  }))
  const terminalTab = useAppStore.getState().createUnifiedTabInSplit(
    'wt-1',
    'terminal',
    {
      sourceGroupId: markdownGroupId,
      splitDirection: 'right'
    },
    {
      id: 'terminal-tab',
      entityId: 'terminal-tab',
      recordInteraction: false
    }
  )
  if (!terminalTab) {
    throw new Error('Missing terminal split')
  }
  return { markdownGroupId, terminalGroupId: terminalTab.groupId }
}

describe('mobile markdown bridge', () => {
  beforeEach(() => {
    resetEditorState()
  })

  afterEach(() => {
    cleanupMobileMarkdownBridgeHarness()
  })

  it('flushes pending rich markdown changes before read', async () => {
    openMarkdownFile()
    setupWindow({
      readFile: vi.fn().mockResolvedValue({ content: 'disk', isBinary: false })
    })
    const detach = attachMobileMarkdownBridge()
    const unregisterFlush = registerPendingEditorFlush('/repo/README.md', () => {
      useAppStore.getState().setEditorDraft('/repo/README.md', '# pending\n')
      useAppStore.getState().markFileDirty('/repo/README.md', true)
    })

    try {
      const response = await sendRequest({
        id: 'read-1',
        operation: 'read',
        worktreeId: 'wt-1',
        tabId: 'tab-md'
      })

      expect(response).toMatchObject({
        id: 'read-1',
        ok: true,
        result: { content: '# pending\n', source: 'draft', editable: true }
      })
    } finally {
      unregisterFlush()
      detach()
    }
  })

  it('reads a hydration fallback markdown tab addressed by its file ID', async () => {
    openMarkdownFile({ withUnifiedTab: false })
    setupWindow({
      readFile: vi.fn().mockResolvedValue({ content: '# fallback\n', isBinary: false })
    })
    const detach = attachMobileMarkdownBridge()

    try {
      const response = await sendRequest({
        id: 'read-hydration-fallback',
        operation: 'read',
        worktreeId: 'wt-1',
        tabId: '/repo/README.md'
      })

      expect(response).toMatchObject({
        id: 'read-hydration-fallback',
        ok: true,
        result: { content: '# fallback\n', editable: true }
      })
    } finally {
      detach()
    }
  })

  it('rejects an unknown markdown tab ID', async () => {
    openMarkdownFile()
    const readFile = vi.fn().mockResolvedValue({ content: '# known\n', isBinary: false })
    setupWindow({ readFile })
    const detach = attachMobileMarkdownBridge()

    try {
      const response = await sendRequest({
        id: 'read-unknown',
        operation: 'read',
        worktreeId: 'wt-1',
        tabId: '/repo/MISSING.md'
      })

      expect(response).toMatchObject({
        id: 'read-unknown',
        ok: false,
        error: 'tab_not_found'
      })
      expect(readFile).not.toHaveBeenCalled()
    } finally {
      detach()
    }
  })

  it('reads a markdown tab outside the desktop-active split group', async () => {
    openMarkdownFile()
    const { markdownGroupId, terminalGroupId } = activateTerminalSplitBesideMarkdown()
    setupWindow({
      readFile: vi.fn().mockResolvedValue({ content: '# inactive\n', isBinary: false })
    })
    const detach = attachMobileMarkdownBridge()

    try {
      expect(useAppStore.getState().activeGroupIdByWorktree['wt-1']).toBe(terminalGroupId)
      const response = await sendRequest({
        id: 'read-inactive-group',
        operation: 'read',
        worktreeId: 'wt-1',
        tabId: 'tab-md'
      })

      expect(response).toMatchObject({
        id: 'read-inactive-group',
        ok: true,
        result: { content: '# inactive\n', editable: true }
      })
      expect(useAppStore.getState().activeGroupIdByWorktree['wt-1']).toBe(terminalGroupId)
      expect(
        useAppStore
          .getState()
          .groupsByWorktree['wt-1']?.find((group) => group.id === markdownGroupId)?.activeTabId
      ).toBe('tab-md')
      expect(
        useAppStore
          .getState()
          .groupsByWorktree['wt-1']?.find((group) => group.id === terminalGroupId)?.activeTabId
      ).toBe('terminal-tab')
    } finally {
      detach()
    }
  })

  it('rejects save when a clean file changed after mobile read', async () => {
    openMarkdownFile()
    const writeFile = vi.fn().mockResolvedValue(undefined)
    setupWindow({
      readFile: vi.fn().mockResolvedValue({ content: 'changed on disk', isBinary: false }),
      writeFile
    })
    const detach = attachMobileMarkdownBridge()

    try {
      const response = await sendRequest({
        id: 'save-1',
        operation: 'save',
        worktreeId: 'wt-1',
        tabId: 'tab-md',
        baseVersion: hashMarkdownContent('original'),
        content: 'mobile edit'
      })

      expect(response).toMatchObject({ id: 'save-1', ok: false, error: 'conflict' })
      expect(writeFile).not.toHaveBeenCalled()
    } finally {
      detach()
    }
  })

  it('saves through the editor save controller and verifies written content', async () => {
    openMarkdownFile()
    const { markdownGroupId, terminalGroupId } = activateTerminalSplitBesideMarkdown()
    let diskContent = 'original'
    const readFile = vi.fn().mockImplementation(async () => ({
      content: diskContent,
      isBinary: false
    }))
    const writeFile = vi.fn().mockImplementation(async ({ content }) => {
      diskContent = content
    })
    setupWindow({ readFile, writeFile })
    const detachBridge = attachMobileMarkdownBridge()
    const detachAutosave = attachEditorAutosaveController(useAppStore as never)

    try {
      expect(useAppStore.getState().activeGroupIdByWorktree['wt-1']).toBe(terminalGroupId)
      const response = await sendRequest({
        id: 'save-2',
        operation: 'save',
        worktreeId: 'wt-1',
        tabId: 'tab-md',
        baseVersion: hashMarkdownContent('original'),
        content: 'mobile edit'
      })

      expect(writeFile).toHaveBeenCalledWith({
        filePath: '/repo/README.md',
        content: 'mobile edit',
        connectionId: undefined,
        expectedExecutionHostId: 'local'
      })
      expect(response).toMatchObject({
        id: 'save-2',
        ok: true,
        result: { content: 'mobile edit', isDirty: false }
      })
      expect(useAppStore.getState().activeGroupIdByWorktree['wt-1']).toBe(terminalGroupId)
      expect(
        useAppStore
          .getState()
          .groupsByWorktree['wt-1']?.find((group) => group.id === markdownGroupId)?.activeTabId
      ).toBe('tab-md')
      expect(
        useAppStore
          .getState()
          .groupsByWorktree['wt-1']?.find((group) => group.id === terminalGroupId)?.activeTabId
      ).toBe('terminal-tab')
    } finally {
      detachAutosave()
      detachBridge()
    }
  })

  it('marks oversized multibyte desktop drafts as read-only for mobile editing', async () => {
    openMarkdownFile()
    const content = '😀'.repeat(Math.floor(MOBILE_MARKDOWN_EDIT_MAX_BYTES / 4) + 1)
    const readFile = vi.fn().mockResolvedValue({ content: 'disk', isBinary: false })
    const state = useAppStore.getState()
    state.setEditorDraft('/repo/README.md', content)
    state.markFileDirty('/repo/README.md', true)
    setupWindow({ readFile })
    const detach = attachMobileMarkdownBridge()

    try {
      const response = await sendRequest({
        id: 'read-large-multibyte',
        operation: 'read',
        worktreeId: 'wt-1',
        tabId: 'tab-md'
      })

      expect(response).toMatchObject({
        id: 'read-large-multibyte',
        ok: true,
        result: { editable: false, readOnlyReason: 'file_too_large' }
      })
      expect(readFile).not.toHaveBeenCalled()
    } finally {
      detach()
    }
  })
})
