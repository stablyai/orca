import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TOGGLE_FLOATING_TERMINAL_EVENT } from '@/lib/floating-terminal'
import type { EditorFilesSlice } from '@/store/slices/editor/types/editor-files-slice'
import type { MarkdownDocument } from '../../../../shared/filesystem-entry-types'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../../shared/constants'
import { registerOsMarkdownFileOpenBridge } from './os-markdown-file-open-bridge'

const mocks = vi.hoisted(() => ({
  openFile: vi.fn<EditorFilesSlice['openFile']>(() => 'file-1'),
  updateSettings: vi.fn(async () => {}),
  isFloatingWorkspacePanelVisible: vi.fn(() => false),
  toastError: vi.fn()
}))

let storeState: {
  openFile: typeof mocks.openFile
  updateSettings: typeof mocks.updateSettings
  settings: { floatingTerminalEnabled?: boolean } | undefined
}

vi.mock('../../store', () => ({ useAppStore: { getState: () => storeState } }))
vi.mock('@/lib/floating-workspace-terminal-actions', () => ({
  isFloatingWorkspacePanelVisible: mocks.isFloatingWorkspacePanelVisible
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
      settings: { floatingTerminalEnabled: true }
    }
    mocks.openFile.mockReturnValue('file-1')
    mocks.updateSettings.mockResolvedValue(undefined)
    mocks.isFloatingWorkspacePanelVisible.mockReturnValue(false)
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

  it('opens every document main queued before the listener attached', async () => {
    stubPreload({
      onOpenMarkdownFiles: () => () => {},
      consumePendingMarkdownFileOpens: () =>
        Promise.resolve([
          markdownDocument(),
          markdownDocument({ filePath: '/Users/me/notes/plan.md', relativePath: 'plan.md' })
        ])
    })

    registerOsMarkdownFileOpenBridge([])
    await settle()

    expect(mocks.openFile).toHaveBeenCalledTimes(2)
    expect(mocks.openFile.mock.calls.map((call) => call[0].filePath)).toEqual([
      '/Users/me/notes/README.md',
      '/Users/me/notes/plan.md'
    ])
    expect(mocks.openFile.mock.calls[0][0].worktreeId).toBe(FLOATING_TERMINAL_WORKTREE_ID)
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
      markdownDocument({ filePath: '/Users/me/notes/live.md', relativePath: 'live.md' })
    ])
    await settle()

    expect(mocks.openFile).toHaveBeenCalledTimes(1)
    expect(mocks.openFile.mock.calls[0][0].filePath).toBe('/Users/me/notes/live.md')

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
  })

  it('leaves settings alone when the floating workspace is already enabled', async () => {
    stubPreload({
      onOpenMarkdownFiles: () => () => {},
      consumePendingMarkdownFileOpens: () => Promise.resolve([markdownDocument()])
    })

    registerOsMarkdownFileOpenBridge([])
    await settle()

    expect(mocks.updateSettings).not.toHaveBeenCalled()
  })

  it('defers the reveal a frame and toggles only while the panel is hidden', async () => {
    stubPreload({
      onOpenMarkdownFiles: () => () => {},
      consumePendingMarkdownFileOpens: () => Promise.resolve([markdownDocument()])
    })

    registerOsMarkdownFileOpenBridge([])
    await settle()

    expect(dispatchEvent).not.toHaveBeenCalled()
    runFrames()

    expect(dispatchEvent).toHaveBeenCalledTimes(1)
    expect(dispatchEvent.mock.calls[0][0].type).toBe(TOGGLE_FLOATING_TERMINAL_EVENT)
  })

  it('does not toggle when the panel is already visible', async () => {
    mocks.isFloatingWorkspacePanelVisible.mockReturnValue(true)
    stubPreload({
      onOpenMarkdownFiles: () => () => {},
      consumePendingMarkdownFileOpens: () => Promise.resolve([markdownDocument()])
    })

    registerOsMarkdownFileOpenBridge([])
    await settle()
    runFrames()

    expect(dispatchEvent).not.toHaveBeenCalled()
  })

  it('ignores an empty batch', async () => {
    storeState.settings = { floatingTerminalEnabled: false }
    stubPreload({
      onOpenMarkdownFiles: () => () => {},
      consumePendingMarkdownFileOpens: () => Promise.resolve([])
    })

    registerOsMarkdownFileOpenBridge([])
    await settle()
    runFrames()

    expect(mocks.openFile).not.toHaveBeenCalled()
    expect(mocks.updateSettings).not.toHaveBeenCalled()
    expect(dispatchEvent).not.toHaveBeenCalled()
  })

  it('reports a rejected pending drain without leaking an unhandled rejection', async () => {
    stubPreload({
      onOpenMarkdownFiles: () => () => {},
      consumePendingMarkdownFileOpens: () => Promise.reject(new Error('ipc unavailable'))
    })

    registerOsMarkdownFileOpenBridge([])
    await settle()

    expect(mocks.toastError).toHaveBeenCalledWith('Failed to open the Markdown file.')
    // Why: App.tsx awaits hydration around this registration and treats any throw as
    // "session restore failed", so the bridge must swallow its own failures.
    expect(unhandledRejections).toEqual([])
  })

  it('reports a throwing openFile without leaking an unhandled rejection', async () => {
    mocks.openFile.mockImplementation(() => {
      throw new Error('editor slice exploded')
    })
    const listeners: MarkdownFileOpenListener[] = []
    stubPreload({
      onOpenMarkdownFiles: (next: MarkdownFileOpenListener) => {
        listeners.push(next)
        return () => {}
      },
      consumePendingMarkdownFileOpens: () => Promise.resolve([])
    })

    registerOsMarkdownFileOpenBridge([])
    expect(() => listeners[0]([markdownDocument()])).not.toThrow()
    await settle()

    expect(mocks.toastError).toHaveBeenCalledWith('Failed to open the Markdown file.')
    expect(unhandledRejections).toEqual([])
    expect(dispatchEvent).not.toHaveBeenCalled()
  })

  it('keeps opening the rest of a batch when one document fails', async () => {
    mocks.openFile.mockImplementationOnce(() => {
      throw new Error('first document exploded')
    })
    stubPreload({
      onOpenMarkdownFiles: () => () => {},
      consumePendingMarkdownFileOpens: () =>
        Promise.resolve([
          markdownDocument({ filePath: '/Users/me/notes/bad.md', relativePath: 'bad.md' }),
          markdownDocument({ filePath: '/Users/me/notes/good.md', relativePath: 'good.md' })
        ])
    })

    registerOsMarkdownFileOpenBridge([])
    await settle()
    runFrames()

    // Why: a multi-file selection arrives as one batch; one bad file must not cost the rest.
    expect(mocks.openFile).toHaveBeenCalledTimes(2)
    expect(mocks.toastError).toHaveBeenCalledTimes(1)
    expect(dispatchEvent).toHaveBeenCalledTimes(1)
    expect(unhandledRejections).toEqual([])
  })

  it('ignores a non-array payload from a mismatched preload', async () => {
    stubPreload({
      onOpenMarkdownFiles: () => () => {},
      // Why: the payload crosses the preload boundary, so a stale preload can resolve with
      // something that is not an array. Reading .length off it would throw inside the chain.
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

  it('tolerates a preload without the markdown open channel', async () => {
    stubPreload({})

    const unsubs: (() => void)[] = []
    expect(() => registerOsMarkdownFileOpenBridge(unsubs)).not.toThrow()
    await settle()

    expect(unsubs).toEqual([])
    expect(mocks.openFile).not.toHaveBeenCalled()
    expect(mocks.toastError).not.toHaveBeenCalled()
  })
})
