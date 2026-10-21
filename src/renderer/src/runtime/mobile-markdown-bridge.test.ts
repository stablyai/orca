import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  hashMarkdownContent,
  MOBILE_MARKDOWN_EDIT_MAX_BYTES,
  MOBILE_MARKDOWN_READ_MAX_BYTES
} from '../../../shared/mobile-markdown-document'
import { attachEditorAutosaveController } from '../components/editor/editor-autosave-controller'
import { ORCA_EDITOR_FILE_CACHE_STALE_EVENT } from '../components/editor/editor-autosave'
import { registerPendingEditorFlush } from '../components/editor/editor-pending-flush'
import { useAppStore } from '../store'
import { getDiskBaselineSignature } from '../../../shared/disk-baseline-signature'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../shared/constants'
import { attachMobileMarkdownBridge } from './mobile-markdown-bridge'
import { MOBILE_STALE_SAVE_MESSAGE } from './mobile-markdown-save-rollback'
import {
  cleanupMobileMarkdownBridgeHarness,
  markdownUnifiedTab,
  openMarkdownFile,
  resetEditorState,
  sendRequest,
  setupWindow,
  guardedWriteRefusal
} from './mobile-markdown-bridge-test-harness'

vi.mock('@/lib/connection-context', () => ({
  getConnectionIdForFile: () => null
}))

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

  it('reads a restored floating-workspace tab for a paired client as user-named', async () => {
    useAppStore.getState().openFile({
      filePath: '/Users/me/notes.md',
      relativePath: 'notes.md',
      worktreeId: FLOATING_TERMINAL_WORKTREE_ID,
      language: 'markdown',
      mode: 'edit'
    })
    const tabId = useAppStore.getState().openFiles[0]?.id ?? ''
    const readFile = vi.fn().mockResolvedValue({ content: '# notes', isBinary: false })
    setupWindow({ readFile })
    const detach = attachMobileMarkdownBridge()

    try {
      const response = await sendRequest({
        id: 'read-floating',
        operation: 'read',
        worktreeId: FLOATING_TERMINAL_WORKTREE_ID,
        tabId
      })

      expect(response).toMatchObject({ ok: true, result: { content: '# notes', source: 'file' } })
      expect(readFile).toHaveBeenCalledWith(
        expect.objectContaining({ filePath: '/Users/me/notes.md', access: { kind: 'user-file' } })
      )
    } finally {
      detach()
    }
  })

  it('reads a project tab for a paired client inside its root', async () => {
    openMarkdownFile()
    const readFile = vi.fn().mockResolvedValue({ content: 'disk', isBinary: false })
    setupWindow({ readFile })
    const detach = attachMobileMarkdownBridge()

    try {
      await sendRequest({
        id: 'read-project',
        operation: 'read',
        worktreeId: 'wt-1',
        tabId: 'tab-md'
      })

      expect(readFile.mock.calls[0]?.[0]).not.toHaveProperty('access')
    } finally {
      detach()
    }
  })

  it('reads a markdown tab that sits in a split group the desktop is not focused on', async () => {
    openMarkdownFile()
    useAppStore.setState({
      unifiedTabsByWorktree: {
        'wt-1': [markdownUnifiedTab('tab-md', '/repo/README.md', 'group-split')]
      },
      groupsByWorktree: {
        'wt-1': [
          { id: 'group-main', worktreeId: 'wt-1', activeTabId: null, tabOrder: [] },
          {
            id: 'group-split',
            worktreeId: 'wt-1',
            activeTabId: 'tab-md',
            tabOrder: ['tab-md']
          }
        ]
      },
      activeGroupIdByWorktree: { 'wt-1': 'group-main' }
    })
    setupWindow({ readFile: vi.fn().mockResolvedValue({ content: '# split', isBinary: false }) })
    const detach = attachMobileMarkdownBridge()

    try {
      const response = await sendRequest({
        id: 'read-split',
        operation: 'read',
        worktreeId: 'wt-1',
        tabId: 'tab-md'
      })

      expect(response).toMatchObject({ ok: true, result: { content: '# split' } })
    } finally {
      detach()
    }
  })

  it('reads the requested tab when the same file is open in two groups', async () => {
    openMarkdownFile()
    useAppStore.setState({
      unifiedTabsByWorktree: {
        'wt-1': [
          markdownUnifiedTab('tab-main', '/repo/README.md', 'group-main'),
          markdownUnifiedTab('tab-split', '/repo/README.md', 'group-split')
        ]
      }
    })
    setupWindow({ readFile: vi.fn().mockResolvedValue({ content: '# both', isBinary: false }) })
    const detach = attachMobileMarkdownBridge()

    try {
      const response = await sendRequest({
        id: 'read-duplicate',
        operation: 'read',
        worktreeId: 'wt-1',
        tabId: 'tab-split'
      })

      expect(response).toMatchObject({
        ok: true,
        result: { tabId: 'tab-split', filePath: '/repo/README.md', content: '# both' }
      })
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
    let diskContent = 'original'
    const readFile = vi.fn().mockImplementation(async () => ({
      content: diskContent,
      isBinary: false
    }))
    const writeFile = vi.fn().mockImplementation(async ({ content, diskPrecondition }) => {
      const refusal = guardedWriteRefusal(diskPrecondition, diskContent)
      if (refusal) {
        return refusal
      }
      diskContent = content
      return { ok: true }
    })
    setupWindow({ readFile, writeFile })
    const detachBridge = attachMobileMarkdownBridge()
    const detachAutosave = attachEditorAutosaveController(useAppStore as never)

    try {
      const response = await sendRequest({
        id: 'save-2',
        operation: 'save',
        worktreeId: 'wt-1',
        tabId: 'tab-md',
        baseVersion: hashMarkdownContent('original'),
        content: 'mobile edit'
      })

      expect(writeFile).toHaveBeenCalledWith(
        expect.objectContaining({
          filePath: '/repo/README.md',
          content: 'mobile edit',
          connectionId: undefined,
          expectedExecutionHostId: 'local',
          diskPrecondition: expect.objectContaining({ allowMissing: true })
        })
      )
      expect(response).toMatchObject({
        id: 'save-2',
        ok: true,
        result: { content: 'mobile edit', isDirty: false }
      })
    } finally {
      detachAutosave()
      detachBridge()
    }
  })

  it('reports a refused phone save to the phone only, with its own message', async () => {
    openMarkdownFile()
    const tabId = useAppStore.getState().openFiles[0].id
    // The tab never loaded on the desktop; the phone read 'original', then an agent wrote.
    let diskContent = 'original'
    const readFile = vi.fn().mockImplementation(async () => {
      const content = diskContent
      diskContent = 'agent rewrite'
      return { content, isBinary: false }
    })
    const writeFile = vi.fn().mockImplementation(async ({ content, diskPrecondition }) => {
      const refusal = guardedWriteRefusal(diskPrecondition, diskContent)
      if (refusal) {
        return refusal
      }
      diskContent = content
      return { ok: true }
    })
    setupWindow({ readFile, writeFile })
    const detachBridge = attachMobileMarkdownBridge()
    const detachAutosave = attachEditorAutosaveController(useAppStore as never)

    try {
      const response = await sendRequest({
        id: 'save-stale',
        operation: 'save',
        worktreeId: 'wt-1',
        tabId: 'tab-md',
        baseVersion: hashMarkdownContent('original'),
        content: 'mobile edit'
      })

      expect(writeFile).toHaveBeenCalledWith(
        expect.objectContaining({
          diskPrecondition: expect.objectContaining({
            expectedSignature: getDiskBaselineSignature('original')
          })
        })
      )
      expect(diskContent).toBe('agent rewrite')
      expect(response).toMatchObject({
        id: 'save-stale',
        ok: false,
        error: MOBILE_STALE_SAVE_MESSAGE
      })
      const tab = useAppStore.getState().openFiles.find((file) => file.id === tabId)
      expect(tab?.externalMutation).toBeUndefined()
      expect(tab?.isDirty).toBe(false)
      // The baseline stamped from the phone's read is withdrawn with the failed save.
      expect(tab?.lastKnownDiskSignature).toBeUndefined()
    } finally {
      detachAutosave()
      detachBridge()
    }
  })

  it.each([
    ['saves', 'D1'],
    ['types', null]
  ] as const)(
    'refuses a phone save when the desktop %s during the phone-verifying read',
    async (_label, desktopSave) => {
      openMarkdownFile()
      const tabId = useAppStore.getState().openFiles[0].id
      useAppStore.getState().setLastKnownDiskSignature(tabId, getDiskBaselineSignature('D0'))
      let diskContent = 'D0'
      const readFile = vi.fn().mockImplementation(async () => {
        const content = diskContent
        if (desktopSave) {
          diskContent = desktopSave
          useAppStore
            .getState()
            .setLastKnownDiskSignature(tabId, getDiskBaselineSignature(desktopSave))
        } else {
          useAppStore.getState().setEditorDraft(tabId, 'desktop typing')
          useAppStore.getState().markFileDirty(tabId, true)
        }
        return { content, isBinary: false }
      })
      const writeFile = vi.fn().mockImplementation(async ({ content, diskPrecondition }) => {
        const refusal = guardedWriteRefusal(diskPrecondition, diskContent)
        if (refusal) {
          return refusal
        }
        diskContent = content
        return { ok: true }
      })
      setupWindow({ readFile, writeFile })
      const detachBridge = attachMobileMarkdownBridge()
      const detachAutosave = attachEditorAutosaveController(useAppStore as never)

      try {
        const response = await sendRequest({
          id: 'save-race',
          operation: 'save',
          worktreeId: 'wt-1',
          tabId: 'tab-md',
          baseVersion: hashMarkdownContent('D0'),
          content: 'phone edit'
        })

        expect(response).toMatchObject({ id: 'save-race', ok: false })
        expect(diskContent).toBe(desktopSave ?? 'D0')
        if (!desktopSave) {
          expect(useAppStore.getState().editorDrafts[tabId]).toBe('desktop typing')
        }
      } finally {
        detachAutosave()
        detachBridge()
      }
    }
  )

  it('lets the phone save after an external change to a clean desktop tab', async () => {
    openMarkdownFile()
    const tabId = useAppStore.getState().openFiles[0].id
    // The desktop loaded 'A' earlier; an agent then wrote 'B' and the desktop tab is still clean.
    useAppStore.getState().setLastKnownDiskSignature(tabId, getDiskBaselineSignature('A'))
    let diskContent = 'B'
    const readFile = vi.fn().mockImplementation(async () => ({
      content: diskContent,
      isBinary: false
    }))
    const writeFile = vi.fn().mockImplementation(async ({ content, diskPrecondition }) => {
      const refusal = guardedWriteRefusal(diskPrecondition, diskContent)
      if (refusal) {
        return refusal
      }
      diskContent = content
      return { ok: true }
    })
    setupWindow({ readFile, writeFile })
    const dropped: string[] = []
    const onStale = (event: Event): void => {
      if (event instanceof CustomEvent) {
        dropped.push(event.detail.fileId)
      }
    }
    window.addEventListener(ORCA_EDITOR_FILE_CACHE_STALE_EVENT, onStale)
    const detachBridge = attachMobileMarkdownBridge()
    const detachAutosave = attachEditorAutosaveController(useAppStore as never)

    try {
      const response = await sendRequest({
        id: 'save-after-change',
        operation: 'save',
        worktreeId: 'wt-1',
        tabId: 'tab-md',
        baseVersion: hashMarkdownContent('B'),
        content: 'phone edit'
      })

      expect(response).toMatchObject({ id: 'save-after-change', ok: true })
      expect(diskContent).toBe('phone edit')
      // The tab's baseline and text both moved to the write, so nothing needed dropping.
      expect(useAppStore.getState().openFiles[0]?.lastKnownDiskSignature).toBe(
        getDiskBaselineSignature('phone edit')
      )
      expect(dropped).toEqual([])
    } finally {
      window.removeEventListener(ORCA_EDITOR_FILE_CACHE_STALE_EVENT, onStale)
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

  it('reads a markdown file between the edit and read budgets whole, as read-only', async () => {
    openMarkdownFile()
    const content = 'a'.repeat(632 * 1024)
    setupWindow({ readFile: vi.fn().mockResolvedValue({ content, isBinary: false }) })
    const detach = attachMobileMarkdownBridge()

    try {
      const response = await sendRequest({
        id: 'read-632k',
        operation: 'read',
        worktreeId: 'wt-1',
        tabId: 'tab-md'
      })

      expect(response).toMatchObject({
        ok: true,
        result: { content, editable: false, readOnlyReason: 'file_too_large' }
      })
      expect(response).not.toHaveProperty('result.truncated')
    } finally {
      detach()
    }
  })

  it('truncates a markdown file over the read budget on a UTF-8 boundary', async () => {
    openMarkdownFile()
    // The 3-byte euro sign straddles the budget, so the cut must drop it whole.
    const prefix = 'a'.repeat(MOBILE_MARKDOWN_READ_MAX_BYTES - 1)
    const content = `${prefix}\u20actail`
    setupWindow({ readFile: vi.fn().mockResolvedValue({ content, isBinary: false }) })
    const detach = attachMobileMarkdownBridge()

    try {
      const response = await sendRequest({
        id: 'read-over-budget',
        operation: 'read',
        worktreeId: 'wt-1',
        tabId: 'tab-md'
      })

      expect(response).toMatchObject({
        ok: true,
        result: {
          editable: false,
          readOnlyReason: 'file_too_large',
          truncated: true,
          byteLength: MOBILE_MARKDOWN_READ_MAX_BYTES - 1 + 3 + 4,
          version: hashMarkdownContent(prefix)
        }
      })
      expect(response).toHaveProperty('result.content', prefix)
      const save = await sendRequest({
        id: 'save-truncated',
        operation: 'save',
        worktreeId: 'wt-1',
        tabId: 'tab-md',
        baseVersion: hashMarkdownContent(prefix),
        content: prefix
      })
      expect(save).toMatchObject({ ok: false, error: 'file_too_large' })
    } finally {
      detach()
    }
  })
})
