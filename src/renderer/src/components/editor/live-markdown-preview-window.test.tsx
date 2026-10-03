// @vitest-environment happy-dom
import type { MarkdownPreviewWindowRequest } from '../../../../shared/document-preview-window'
import { act, type ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { OpenFile } from '@/store/slices/editor'
import { followMarkdownPreviewWindow } from './live-markdown-preview-window'

const file: OpenFile = {
  id: 'report',
  filePath: '/repo/report.md',
  relativePath: 'report.md',
  worktreeId: 'wt-1',
  language: 'markdown',
  mode: 'edit',
  isDirty: false
}
const mocks = vi.hoisted(() => ({
  read: vi.fn(),
  update: vi.fn(async (_request: MarkdownPreviewWindowRequest) => true),
  closed: (_fileId: string): void => {},
  state: { openFiles: new Array<OpenFile>(), editorDrafts: new Map<string, string>() }
}))
vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => ({
      openFiles: mocks.state.openFiles,
      editorDrafts: Object.fromEntries(mocks.state.editorDrafts)
    })
  }
}))
vi.mock('./MarkdownPreview', () => ({
  default: ({ content }: { content: string }) => <div className="markdown-body">{content}</div>
}))
vi.mock('./RichMarkdownErrorBoundary', () => ({
  RichMarkdownErrorBoundary: ({ children }: { children: ReactNode }) => children
}))
vi.mock('@/i18n/I18nProvider', () => ({
  I18nProvider: ({ children }: { children: ReactNode }) => children
}))
vi.mock('@/components/ui/tooltip', () => ({
  TooltipProvider: ({ children }: { children: ReactNode }) => children
}))

let dispose = (): void => {}
async function tick(ms: number): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms)
  })
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.clearAllMocks()
  mocks.state.openFiles = [file]
  mocks.state.editorDrafts.clear()
  mocks.read.mockResolvedValue({ open: true, content: 'First', error: null })
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      docPreview: {
        readMarkdownWindowSource: mocks.read,
        updateMarkdownWindow: mocks.update,
        onMarkdownWindowClosed: (callback: (fileId: string) => void) => {
          mocks.closed = callback
          return () => {}
        }
      }
    }
  })
})
afterEach(async () => {
  await act(async () => {
    dispose()
  })
  vi.useRealTimers()
})

async function start(): Promise<void> {
  await act(async () => {
    dispose = followMarkdownPreviewWindow(file, { title: 'Report', html: '<p>Initial</p>' })
  })
  await tick(250)
}

describe('live Markdown companion', () => {
  it('follows later disk changes even after the source tab closes, then stops on window close', async () => {
    await start()
    expect(mocks.update.mock.calls.at(-1)?.[0].html).toContain('First')
    mocks.state.openFiles = []
    mocks.read.mockResolvedValue({ open: true, content: 'Second', error: null })
    await tick(2000)
    await tick(250)
    expect(mocks.update.mock.calls.at(-1)?.[0].html).toContain('Second')
    expect(document.querySelector('[hidden][inert]')).not.toBeNull()
    await act(async () => {
      mocks.closed(file.id)
    })
    const reads = mocks.read.mock.calls.length
    await tick(5000)
    expect(mocks.read).toHaveBeenCalledTimes(reads)
    expect(document.querySelector('[hidden][inert]')).toBeNull()
  })

  it('keeps the last document on disconnect and recovers when the original host responds', async () => {
    await start()
    mocks.read.mockResolvedValue({ open: true, content: null, error: 'Host disconnected' })
    await tick(2000)
    await tick(250)
    expect(mocks.update.mock.calls.at(-1)?.[0]).toMatchObject({ refreshError: 'Host disconnected' })
    expect(mocks.update.mock.calls.at(-1)?.[0].html).toContain('First')
    mocks.read.mockResolvedValue({ open: true, content: 'Recovered', error: null })
    await tick(2000)
    await tick(250)
    expect(mocks.update.mock.calls.at(-1)?.[0].html).toContain('Recovered')
    expect(mocks.update.mock.calls.at(-1)?.[0].refreshError).toBeNull()
  })

  it('shows unsaved edits instead of an older disk read', async () => {
    mocks.state.openFiles = [{ ...file, isDirty: true }]
    mocks.state.editorDrafts.set(file.id, 'Unsaved draft')
    await start()
    expect(mocks.update.mock.calls.at(-1)?.[0].html).toContain('Unsaved draft')
  })
})
