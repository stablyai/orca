/* eslint-disable max-lines */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  hashMarkdownContent,
  type RuntimeMobileMarkdownRequest
} from '../../../shared/mobile-markdown-document'
import { attachEditorAutosaveController } from '../components/editor/editor-autosave-controller'
import { registerPendingEditorFlush } from '../components/editor/editor-pending-flush'
import { useAppStore } from '../store'
import { attachMobileMarkdownBridge } from './mobile-markdown-bridge'

vi.mock('@/components/tab-bar/group-tab-order', () => ({
  getActiveTabNavOrder: () => [{ type: 'editor', id: '/repo/README.md', tabId: 'tab-md' }]
}))

vi.mock('@/lib/connection-context', () => ({
  getConnectionId: () => null
}))

type WindowStub = {
  addEventListener: Window['addEventListener']
  removeEventListener: Window['removeEventListener']
  dispatchEvent: Window['dispatchEvent']
  setTimeout: Window['setTimeout']
  clearTimeout: Window['clearTimeout']
  api: {
    ui: {
      onMobileMarkdownRequest: (
        callback: (request: RuntimeMobileMarkdownRequest) => void
      ) => () => void
      respondMobileMarkdownRequest: ReturnType<typeof vi.fn>
    }
    fs: {
      readFile: ReturnType<typeof vi.fn>
      writeFile: ReturnType<typeof vi.fn>
    }
  }
}

let mobileMarkdownHandler: ((request: RuntimeMobileMarkdownRequest) => void) | null = null

function setupWindow({
  readFile,
  writeFile = vi.fn().mockResolvedValue(undefined)
}: {
  readFile: ReturnType<typeof vi.fn>
  writeFile?: ReturnType<typeof vi.fn>
}): { responses: unknown[] } {
  const eventTarget = new EventTarget()
  const responses: unknown[] = []
  mobileMarkdownHandler = null
  vi.stubGlobal('window', {
    addEventListener: eventTarget.addEventListener.bind(eventTarget),
    removeEventListener: eventTarget.removeEventListener.bind(eventTarget),
    dispatchEvent: eventTarget.dispatchEvent.bind(eventTarget),
    setTimeout: globalThis.setTimeout.bind(globalThis),
    clearTimeout: globalThis.clearTimeout.bind(globalThis),
    api: {
      ui: {
        onMobileMarkdownRequest: (callback) => {
          mobileMarkdownHandler = callback
          return () => {
            mobileMarkdownHandler = null
          }
        },
        respondMobileMarkdownRequest: vi.fn((response) => responses.push(response))
      },
      fs: { readFile, writeFile }
    }
  } satisfies WindowStub)
  return { responses }
}

function resetEditorState(): void {
  useAppStore.setState({
    openFiles: [],
    editorDrafts: {},
    worktreesByRepo: { repo: [{ id: 'wt-1', repoId: 'repo', path: '/repo', branch: 'main' }] },
    repos: [{ id: 'repo', path: '/repo', displayName: 'repo', kind: 'git' }]
  } as never)
}

function openMarkdownFile(): void {
  useAppStore.getState().openFile({
    filePath: '/repo/README.md',
    relativePath: 'README.md',
    worktreeId: 'wt-1',
    language: 'markdown',
    mode: 'edit'
  })
}

async function sendRequest(request: RuntimeMobileMarkdownRequest): Promise<unknown> {
  expect(mobileMarkdownHandler).not.toBeNull()
  mobileMarkdownHandler?.(request)
  for (let i = 0; i < 20; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0))
    const response = (
      window.api.ui.respondMobileMarkdownRequest as ReturnType<typeof vi.fn>
    ).mock.calls
      .map((call) => call[0])
      .find((candidate) => candidate?.id === request.id)
    if (response) {
      return response
    }
  }
  throw new Error(`No response for ${request.id}`)
}

function createDeferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve: () => void = () => {}
  const promise = new Promise<void>((next) => {
    resolve = next
  })
  return { promise, resolve }
}

describe('mobile markdown bridge', () => {
  beforeEach(() => {
    resetEditorState()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    mobileMarkdownHandler = null
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
        content: 'mobile edit'
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

  it('restores the previous desktop draft when a mobile save write fails', async () => {
    openMarkdownFile()
    const state = useAppStore.getState()
    state.setEditorDraft('/repo/README.md', 'desktop draft')
    state.markFileDirty('/repo/README.md', true)
    setupWindow({
      readFile: vi.fn().mockResolvedValue({ content: 'desktop draft', isBinary: false }),
      writeFile: vi.fn().mockRejectedValue(new Error('disk full'))
    })
    const detachBridge = attachMobileMarkdownBridge()
    const detachAutosave = attachEditorAutosaveController(useAppStore as never)

    try {
      const response = await sendRequest({
        id: 'save-fail',
        operation: 'save',
        worktreeId: 'wt-1',
        tabId: 'tab-md',
        baseVersion: hashMarkdownContent('desktop draft'),
        content: 'mobile edit'
      })

      expect(response).toMatchObject({ id: 'save-fail', ok: false })
      expect(useAppStore.getState().editorDrafts['/repo/README.md']).toBe('desktop draft')
      expect(useAppStore.getState().openFiles[0]?.isDirty).toBe(true)
    } finally {
      detachAutosave()
      detachBridge()
    }
  })

  it('restores the previous desktop draft when save verification fails after write', async () => {
    openMarkdownFile()
    const state = useAppStore.getState()
    state.setEditorDraft('/repo/README.md', 'desktop draft')
    state.markFileDirty('/repo/README.md', true)
    let diskContent = 'desktop draft'
    const readFile = vi.fn().mockImplementation(async () => ({
      content: 'verified mismatch',
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
        id: 'save-verify-fail',
        operation: 'save',
        worktreeId: 'wt-1',
        tabId: 'tab-md',
        baseVersion: hashMarkdownContent('desktop draft'),
        content: 'mobile edit'
      })

      expect(response).toMatchObject({ id: 'save-verify-fail', ok: false })
      expect(diskContent).toBe('mobile edit')
      expect(useAppStore.getState().editorDrafts['/repo/README.md']).toBe('desktop draft')
      expect(useAppStore.getState().openFiles[0]?.isDirty).toBe(true)
    } finally {
      detachAutosave()
      detachBridge()
    }
  })

  it('serializes saves so duplicate base versions do not both write', async () => {
    openMarkdownFile()
    let diskContent = 'original'
    const firstWrite = createDeferred()
    const readFile = vi.fn().mockImplementation(async () => ({
      content: diskContent,
      isBinary: false
    }))
    const writeFile = vi.fn().mockImplementation(async ({ content }) => {
      if (content === 'first edit') {
        await firstWrite.promise
      }
      diskContent = content
    })
    setupWindow({ readFile, writeFile })
    const detachBridge = attachMobileMarkdownBridge()
    const detachAutosave = attachEditorAutosaveController(useAppStore as never)

    try {
      const first = sendRequest({
        id: 'save-a',
        operation: 'save',
        worktreeId: 'wt-1',
        tabId: 'tab-md',
        baseVersion: hashMarkdownContent('original'),
        content: 'first edit'
      })
      await new Promise((resolve) => setTimeout(resolve, 0))
      const second = sendRequest({
        id: 'save-b',
        operation: 'save',
        worktreeId: 'wt-1',
        tabId: 'tab-md',
        baseVersion: hashMarkdownContent('original'),
        content: 'second edit'
      })
      firstWrite.resolve()

      await expect(first).resolves.toMatchObject({ id: 'save-a', ok: true })
      await expect(second).resolves.toMatchObject({ id: 'save-b', ok: false, error: 'conflict' })
      expect(diskContent).toBe('first edit')
    } finally {
      detachAutosave()
      detachBridge()
    }
  })

  it('treats a duplicate same-content save as idempotent success', async () => {
    openMarkdownFile()
    let diskContent = 'original'
    const firstWrite = createDeferred()
    const readFile = vi.fn().mockImplementation(async () => ({
      content: diskContent,
      isBinary: false
    }))
    const writeFile = vi.fn().mockImplementation(async ({ content }) => {
      if (content === 'mobile edit' && diskContent === 'original') {
        await firstWrite.promise
      }
      diskContent = content
    })
    setupWindow({ readFile, writeFile })
    const detachBridge = attachMobileMarkdownBridge()
    const detachAutosave = attachEditorAutosaveController(useAppStore as never)

    try {
      const first = sendRequest({
        id: 'save-a',
        operation: 'save',
        worktreeId: 'wt-1',
        tabId: 'tab-md',
        baseVersion: hashMarkdownContent('original'),
        content: 'mobile edit'
      })
      await new Promise((resolve) => setTimeout(resolve, 0))
      const second = sendRequest({
        id: 'save-b',
        operation: 'save',
        worktreeId: 'wt-1',
        tabId: 'tab-md',
        baseVersion: hashMarkdownContent('original'),
        content: 'mobile edit'
      })
      firstWrite.resolve()

      await expect(first).resolves.toMatchObject({ id: 'save-a', ok: true })
      await expect(second).resolves.toMatchObject({ id: 'save-b', ok: true })
      expect(diskContent).toBe('mobile edit')
    } finally {
      detachAutosave()
      detachBridge()
    }
  })
})
