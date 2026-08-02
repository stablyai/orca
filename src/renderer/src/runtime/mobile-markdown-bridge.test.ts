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

vi.mock('@/components/tab-bar/group-tab-order', () => ({
  getActiveTabNavOrder: () => [{ type: 'editor', id: '/repo/README.md', tabId: 'tab-md' }]
}))

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
    const writeFile = vi.fn().mockImplementation(async ({ content }) => {
      diskContent = content
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
