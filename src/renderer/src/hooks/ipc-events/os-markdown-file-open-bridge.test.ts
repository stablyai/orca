import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { EditorFilesSlice } from '@/store/slices/editor/types/editor-files-slice'
import type { MarkdownDocument } from '../../../../shared/file-listing/file-document'

import { registerOsMarkdownFileOpenBridge } from './os-markdown-file-open-bridge'

const mocks = vi.hoisted(() => ({
  openFile: vi.fn<EditorFilesSlice['openFile']>(() => 'file-1'),
  updateSettings: vi.fn(async (_updates: { floatingTerminalEnabled?: boolean }) => {}),
  toastError: vi.fn(),
  subscribe: vi.fn<(listener: (state: { workspaceSessionReady: boolean }) => void) => () => void>()
}))

let storeState: {
  openFile: typeof mocks.openFile
  updateSettings: typeof mocks.updateSettings
  settings: { floatingTerminalEnabled?: boolean } | undefined
  floatingWorkspacePanelOpen: boolean
  workspaceSessionReady: boolean
}

vi.mock('../../store', () => ({
  useAppStore: { getState: () => storeState, subscribe: mocks.subscribe }
}))
vi.mock('sonner', () => ({ toast: { error: mocks.toastError } }))
vi.mock('@/i18n/i18n', () => ({ translate: (_key: string, fallback: string) => fallback }))

type MarkdownFileOpenListener = (documents: MarkdownDocument[]) => void

let frames: FrameRequestCallback[] = []
let dispatchEvent = vi.fn()
let unhandledRejections: unknown[] = []
const recordUnhandledRejection = (reason: unknown): void => void unhandledRejections.push(reason)

function markdownDocument(overrides: Partial<MarkdownDocument> = {}): MarkdownDocument {
  return {
    filePath: '/Users/me/notes/README.md',
    relativePath: 'README.md',
    basename: 'README.md',
    name: 'README',
    ...overrides
  }
}

function stubPreload(ui: Record<string, unknown>): void {
  dispatchEvent = vi.fn()
  vi.stubGlobal('window', { api: { ui }, dispatchEvent })
}

/** Runs the callbacks the bridge deferred to the next frame. */
function runFrames(): void {
  const pending = frames
  frames = []
  for (const frame of pending) {
    frame(0)
  }
}

/** Drains microtasks and lets Node emit any unhandled rejection the bridge leaked. */
async function settle(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve))
  await new Promise((resolve) => setImmediate(resolve))
}

describe('registerOsMarkdownFileOpenBridge', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    frames = []
    unhandledRejections = []
    storeState = {
      openFile: mocks.openFile,
      updateSettings: mocks.updateSettings,
      settings: { floatingTerminalEnabled: true },
      floatingWorkspacePanelOpen: false,
      workspaceSessionReady: true
    }
    mocks.openFile.mockReturnValue('file-1')
    mocks.updateSettings.mockImplementation(
      async (updates: { floatingTerminalEnabled?: boolean }) => {
        storeState.settings = { ...storeState.settings, ...updates }
      }
    )
    mocks.subscribe.mockReset().mockReturnValue(() => {})
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) =>
      frames.push(callback)
    )
    vi.spyOn(console, 'error').mockImplementation(() => {})
    process.on('unhandledRejection', recordUnhandledRejection)
  })

  afterEach(() => {
    process.off('unhandledRejection', recordUnhandledRejection)
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('opens documents pushed after startup and hands back the unsubscribe', async () => {
    const listeners: MarkdownFileOpenListener[] = []
    const unsubscribe = vi.fn()
    stubPreload({
      onOpenMarkdownFiles: (next: MarkdownFileOpenListener) => {
        listeners.push(next)
        return unsubscribe
      },
      consumePendingMarkdownFileOpens: () => Promise.resolve([])
    })

    const unsubs: (() => void)[] = []
    registerOsMarkdownFileOpenBridge(unsubs)
    expect(unsubs).toEqual([unsubscribe])

    listeners[0]([
      markdownDocument({ filePath: '/Users/me/notes/live.tsv', relativePath: 'live.tsv' })
    ])
    await settle()

    expect(mocks.openFile).toHaveBeenCalledTimes(1)
    expect(mocks.openFile.mock.calls[0][0].filePath).toBe('/Users/me/notes/live.tsv')

    unsubs.forEach((teardown) => teardown())
    expect(unsubscribe).toHaveBeenCalledOnce()
  })

  it('enables the floating workspace when the setting is off', async () => {
    storeState.settings = { floatingTerminalEnabled: false }
    stubPreload({
      onOpenMarkdownFiles: () => () => {},
      consumePendingMarkdownFileOpens: () => Promise.resolve([markdownDocument()])
    })

    registerOsMarkdownFileOpenBridge([])
    await settle()

    expect(mocks.updateSettings).toHaveBeenCalledWith({ floatingTerminalEnabled: true })
    runFrames()
    expect(dispatchEvent).toHaveBeenCalledTimes(1)
  })

  it('ignores a non-array payload from a mismatched preload', async () => {
    stubPreload({
      onOpenMarkdownFiles: () => () => {},
      // Older preloads can return non-arrays; validate before reading length across the boundary.
      consumePendingMarkdownFileOpens: () => Promise.resolve(null as unknown as MarkdownDocument[])
    })

    registerOsMarkdownFileOpenBridge([])
    await settle()
    runFrames()

    expect(mocks.openFile).not.toHaveBeenCalled()
    expect(mocks.updateSettings).not.toHaveBeenCalled()
    expect(mocks.toastError).not.toHaveBeenCalled()
    expect(unhandledRejections).toEqual([])
  })
})
