// @vitest-environment happy-dom
import { act, cleanup, render } from '@testing-library/react'
import { Toaster } from 'sonner'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { deliverNativeTerminalFileDrop } from './terminal-native-file-drop'
import { captureTerminalDropTarget } from './terminal-drop-target'
import { writeTerminalDropPathsToCapturedTarget } from './terminal-drop-path-writer'
import { importExternalPathsToRuntime } from '@/runtime/files/imports/runtime-file-import-client'

vi.mock('@/i18n/i18n', () => ({ translate: (_key: string, fallback: string) => fallback }))

vi.mock('@/runtime/files/imports/runtime-file-import-client', () => ({
  importExternalPathsToRuntime: vi.fn()
}))

vi.mock('./terminal-drop-path-writer', () => ({
  writeTerminalDropPathsToCapturedTarget: vi.fn<WritePathsToCapturedTarget>(async () => ({
    sentAnyPath: true,
    targetCurrent: true,
    pathsWritten: 1
  }))
}))

type WritePathsToCapturedTarget = typeof writeTerminalDropPathsToCapturedTarget

const goneTitle = "Upload finished, but the terminal wasn't open to type the path. Files are at:"
const uploadedPath = '/srv/orca/workspaces/api-server/.orca/drops/model-eval-results.bin'
const secondUploadedPath = '/srv/orca/workspaces/api-server/.orca/drops/eval-notes.md'

const frames: FrameRequestCallback[] = []

type DropArgs = Parameters<typeof deliverNativeTerminalFileDrop>[0]

function createDropArgs(panes: { id: number; leafId: string }[]): { args: DropArgs } {
  const pane = { id: 7, leafId: 'leaf-7' }
  const transport = {
    getPtyId: vi.fn(() => 'pty-7'),
    isConnected: vi.fn(() => true)
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the drop flow reads only getPtyId/isConnected off the captured transport; any other member it needed would fail these tests at call time.
  const capturedTransport = transport as never
  return {
    args: {
      dataPaths: ['/Users/me/Downloads/model-eval-results.bin'],
      dropTarget: captureTerminalDropTarget(pane, capturedTransport),
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the paste-time transport lookup reads only getPanes; a wider PaneManager surface is irrelevant here.
      manager: { getPanes: () => panes } as never,
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: keyed by pane id and holding the same fake transport captured above.
      paneTransports: new Map([[pane.id, capturedTransport]]) as never,
      pane,
      tabId: 'tab-1',
      worktreePath: '/srv/orca/workspaces/api-server',
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the runtime upload branch reads only runtimeEnvironmentId from the owner.
      owner: { runtimeEnvironmentId: 'env-1' } as never,
      worktreeId: 'wt-1',
      localWslDrop: false
    }
  }
}

function mockImportResults(results: unknown): void {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the mocked import supplies exactly the status/destPath/reason fields the drop flow consumes.
  vi.mocked(importExternalPathsToRuntime).mockResolvedValue({ results } as never)
}

async function deliverDrop(args: DropArgs): Promise<void> {
  await act(async () => {
    await deliverNativeTerminalFileDrop(args)
    await vi.advanceTimersByTimeAsync(0)
  })
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  let nextFrameId = 0
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    frames.push(callback)
    return ++nextFrameId
  })
})

afterEach(() => {
  cleanup()
  frames.length = 0
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})

it('shows where the files landed when the dropped pane is gone after the upload', async () => {
  mockImportResults([{ status: 'imported', destPath: uploadedPath }])
  const view = render(<Toaster closeButton />)
  const { args } = createDropArgs([])

  await deliverDrop(args)

  expect(view.queryByText(goneTitle)).not.toBeNull()
  expect(view.queryByText(uploadedPath)).not.toBeNull()
  expect(writeTerminalDropPathsToCapturedTarget).not.toHaveBeenCalled()
})

it('still writes the paths when the dropped pane stays mounted', async () => {
  mockImportResults([{ status: 'imported', destPath: uploadedPath }])
  const view = render(<Toaster closeButton />)
  const { args } = createDropArgs([{ id: 7, leafId: 'leaf-7' }])

  await deliverDrop(args)

  expect(writeTerminalDropPathsToCapturedTarget).toHaveBeenCalledWith(
    expect.objectContaining({ paths: [uploadedPath] })
  )
  expect(view.queryByText(goneTitle)).toBeNull()
})

it('stays silent when the upload produced no paths to point at', async () => {
  mockImportResults([{ status: 'skipped', reason: 'symlink' }])
  const view = render(<Toaster closeButton />)
  const { args } = createDropArgs([])

  await deliverDrop(args)

  expect(view.queryByText(goneTitle)).toBeNull()
  expect(writeTerminalDropPathsToCapturedTarget).not.toHaveBeenCalled()
})

it('reports the untyped remainder when the pane goes stale mid-write', async () => {
  mockImportResults([
    { status: 'imported', destPath: uploadedPath },
    { status: 'imported', destPath: secondUploadedPath }
  ])
  vi.mocked(writeTerminalDropPathsToCapturedTarget).mockResolvedValueOnce({
    sentAnyPath: true,
    targetCurrent: false,
    pathsWritten: 1,
    failureReason: 'target-stale'
  })
  const view = render(<Toaster closeButton />)
  const { args } = createDropArgs([{ id: 7, leafId: 'leaf-7' }])

  await deliverDrop(args)

  expect(view.queryByText(goneTitle)).not.toBeNull()
  expect(view.container.textContent).toContain(secondUploadedPath)
  expect(view.container.textContent).not.toContain(uploadedPath)
})

it('copies the landed paths from the toast Copy action', async () => {
  const writeClipboardText = vi.fn(() => Promise.resolve())
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the toast action reads only ui.writeClipboardText off window.api; any other member would fail this test at call time.
  window.api = { ui: { writeClipboardText } } as never
  mockImportResults([{ status: 'imported', destPath: uploadedPath }])
  const view = render(<Toaster closeButton />)
  const { args } = createDropArgs([])

  await deliverDrop(args)

  await act(async () => {
    view.getByText('Copy').click()
  })
  expect(writeClipboardText).toHaveBeenCalledWith(uploadedPath)
})

it('reports a failed copy from the toast Copy action', async () => {
  const writeClipboardText = vi.fn(() => Promise.reject(new Error('clipboard unavailable')))
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the toast action reads only ui.writeClipboardText off window.api; any other member would fail this test at call time.
  window.api = { ui: { writeClipboardText } } as never
  mockImportResults([{ status: 'imported', destPath: uploadedPath }])
  const view = render(<Toaster closeButton />)
  const { args } = createDropArgs([])

  await deliverDrop(args)

  await act(async () => {
    view.getByText('Copy').click()
    await vi.advanceTimersByTimeAsync(0)
  })
  expect(view.queryByText("Couldn't copy the paths.")).not.toBeNull()
})
