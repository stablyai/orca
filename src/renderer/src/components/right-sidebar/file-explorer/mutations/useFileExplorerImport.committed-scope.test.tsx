// @vitest-environment happy-dom
import { Suspense, startTransition } from 'react'
import { act, cleanup, fireEvent, render, waitFor, within } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { useFileExplorerImport } from './useFileExplorerImport'
import { FileExplorerKeyboardPasteConfirmationDialog } from '../panel/FileExplorerKeyboardPasteConfirmationDialog'

const mocks = vi.hoisted(() => ({ importPaths: vi.fn(), prepare: vi.fn() }))
vi.mock('@/runtime/files/imports/runtime-file-import-client', () => ({
  importExternalPathsToRuntime: mocks.importPaths
}))
vi.mock('../navigation/file-explorer-operation-owner', () => ({
  captureFileExplorerOperationGuard: () => ({ route: {}, assertCurrent: vi.fn() })
}))
vi.mock('sonner', () => ({ toast: { error: vi.fn() } }))
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})

function dropOn(target: Element): { dropEffect: string } {
  const transfer = { types: ['Files'], files: [new File(['a'], 'file.ts')], dropEffect: 'move' }
  for (const type of ['dragover', 'drop']) {
    const event = new Event(type, { bubbles: true, cancelable: true, composed: true })
    Object.defineProperty(event, 'dataTransfer', { value: transfer })
    Object.defineProperty(event, 'isTrusted', { value: true })
    target.dispatchEvent(event)
  }
  return transfer
}

function pasteOn(target: Element): Event {
  const event = new Event('paste', { bubbles: true, cancelable: true })
  target.dispatchEvent(event)
  return event
}

async function confirmKeyboardPaste(view: ReturnType<typeof render>): Promise<void> {
  const dialog = await view.findByRole('dialog')
  fireEvent.click(within(dialog).getByRole('button', { name: 'Paste' }))
}

it('keeps native drops on committed scope when a new scope render suspends', async () => {
  vi.stubGlobal('api', {
    fs: {
      getPathForFile: () => '/source/file.ts',
      prepareDroppedPaths: mocks.prepare.mockImplementation(async ({ paths }) => ({
        paths,
        failures: []
      }))
    }
  })
  const selected = vi.fn()
  const clearDrag = vi.fn()
  const refresh = vi.fn().mockResolvedValue(undefined)
  const suspended = new Promise<void>(() => {})
  mocks.importPaths.mockResolvedValue({
    results: [{ status: 'imported', destPath: '/repo/app/file.ts' }]
  })

  function Probe({ scope, suspend = false }: { scope: string; suspend?: boolean }) {
    const { fileDropOwnerRef } = useFileExplorerImport({
      worktreeId: 'wt',
      worktreePath: '/repo',
      displayRootPath: scope,
      refreshDir: refresh,
      clearNativeDragState: clearDrag,
      setSelectedPath: selected
    })
    if (suspend) {
      throw suspended
    }
    return (
      <div ref={fileDropOwnerRef}>
        <span data-testid="row" data-file-explorer-drop-dir="/repo/app">
          {scope}
        </span>
      </div>
    )
  }
  const view = render(
    <Suspense fallback="Loading">
      <Probe scope="/repo/app" />
    </Suspense>
  )
  await act(async () => {
    startTransition(() =>
      view.rerender(
        <Suspense fallback="Loading">
          <Probe scope="/repo/api" suspend />
        </Suspense>
      )
    )
  })
  expect(view.getByText('/repo/app')).toBeTruthy()
  await act(async () => {
    dropOn(view.getByTestId('row'))
  })
  await waitFor(() => expect(selected).toHaveBeenCalledWith('/repo/app/file.ts'))
  expect(refresh).toHaveBeenCalledWith('/repo/app')

  selected.mockClear()
  view.rerender(
    <Suspense fallback="Loading">
      <Probe scope="/repo/api" />
    </Suspense>
  )
  let transfer: { dropEffect: string } | undefined
  await act(async () => {
    transfer = dropOn(view.getByTestId('row'))
  })
  // The row still names /repo/app, which is outside the committed /repo/api root.
  expect(transfer?.dropEffect).toBe('none')
  expect(selected).not.toHaveBeenCalled()
  expect(mocks.importPaths).toHaveBeenCalledTimes(1)
  expect(refresh).toHaveBeenCalledTimes(1)
  expect(mocks.prepare).toHaveBeenCalledTimes(1)
})

it('pastes copied files and clipboard images into the target folder without intercepting text fields', async () => {
  const ui = {
    readClipboardText: vi.fn(async () => 'file.ts'),
    readClipboardFilePaths: vi.fn(async () => ['/source/file.ts']),
    clipboardHasImage: vi.fn(async () => false),
    saveClipboardImageAsTempFile: vi.fn(async () => '/tmp/pasted-image.png')
  }
  vi.stubGlobal('api', {
    fs: {
      getPathForFile: () => '/source/file.ts',
      prepareDroppedPaths: mocks.prepare.mockImplementation(async ({ paths }) => ({
        paths,
        failures: []
      }))
    },
    ui
  })
  const selected = vi.fn()
  const refresh = vi.fn().mockResolvedValue(undefined)
  mocks.importPaths
    .mockResolvedValueOnce({ results: [{ status: 'imported', destPath: '/repo/app/file.ts' }] })
    .mockResolvedValueOnce({ results: [{ status: 'imported', destPath: '/repo/file.ts' }] })
    .mockResolvedValueOnce({
      results: [{ status: 'imported', destPath: '/repo/app/pasted-image.png' }]
    })

  function Probe() {
    const fileExplorerImport = useFileExplorerImport({
      worktreeId: 'wt',
      worktreePath: '/repo',
      displayRootPath: '/repo',
      refreshDir: refresh,
      clearNativeDragState: vi.fn(),
      setSelectedPath: selected
    })
    return (
      <>
        <div ref={fileExplorerImport.fileDropOwnerRef}>
          <button
            data-testid="folder"
            data-file-explorer-drop-dir="/repo/app"
            data-file-explorer-drop-directory=""
          >
            app
          </button>
          <button data-testid="file" data-file-explorer-drop-dir="/repo/app">
            file
          </button>
          <input data-testid="text-input" />
        </div>
        <FileExplorerKeyboardPasteConfirmationDialog
          open={fileExplorerImport.keyboardPasteConfirmationOpen}
          onCancel={fileExplorerImport.cancelKeyboardPasteConfirmation}
          onConfirm={fileExplorerImport.confirmKeyboardPasteConfirmation}
        />
      </>
    )
  }

  const view = render(<Probe />)
  await act(async () => {
    pasteOn(view.getByTestId('folder'))
  })
  await confirmKeyboardPaste(view)
  await waitFor(() => expect(selected).toHaveBeenCalledWith('/repo/app/file.ts'))
  expect(refresh).toHaveBeenCalledWith('/repo/app')

  await act(async () => {
    pasteOn(view.getByTestId('file'))
  })
  await confirmKeyboardPaste(view)
  await waitFor(() => expect(selected).toHaveBeenCalledWith('/repo/file.ts'))
  expect(refresh).toHaveBeenCalledWith('/repo')

  ui.readClipboardText.mockResolvedValue('')
  ui.readClipboardFilePaths.mockResolvedValue([])
  ui.clipboardHasImage.mockResolvedValue(true)
  await act(async () => {
    pasteOn(view.getByTestId('folder'))
  })
  await confirmKeyboardPaste(view)
  await waitFor(() => expect(selected).toHaveBeenCalledWith('/repo/app/pasted-image.png'))
  expect(ui.saveClipboardImageAsTempFile).toHaveBeenCalledOnce()
  expect(refresh).toHaveBeenCalledTimes(3)

  const textPaste = pasteOn(view.getByTestId('text-input'))
  expect(textPaste.defaultPrevented).toBe(false)
})

it('captures clipboard paths before waiting for an earlier paste delivery', async () => {
  let clipboardPath = '/source/first.ts'
  const ui = {
    readClipboardText: vi.fn(async () => ''),
    readClipboardFilePaths: vi.fn(async () => [clipboardPath]),
    clipboardHasImage: vi.fn(async () => false),
    saveClipboardImageAsTempFile: vi.fn(async () => null)
  }
  vi.stubGlobal('api', {
    fs: {
      prepareDroppedPaths: mocks.prepare.mockImplementation(async ({ paths }) => ({
        paths,
        failures: []
      }))
    },
    ui
  })
  let releaseFirstImport!: () => void
  const firstImport = new Promise((resolve) => {
    releaseFirstImport = () =>
      resolve({ results: [{ status: 'imported', destPath: '/repo/app/first.ts' }] })
  })
  mocks.importPaths.mockReturnValueOnce(firstImport).mockResolvedValueOnce({
    results: [{ status: 'imported', destPath: '/repo/app/second.ts' }]
  })

  function Probe() {
    const fileExplorerImport = useFileExplorerImport({
      worktreeId: 'wt',
      worktreePath: '/repo',
      displayRootPath: '/repo',
      refreshDir: vi.fn().mockResolvedValue(undefined),
      clearNativeDragState: vi.fn(),
      setSelectedPath: vi.fn()
    })
    return (
      <div ref={fileExplorerImport.fileDropOwnerRef}>
        <button onClick={() => fileExplorerImport.pasteToDirectory('/repo/app')}>Paste</button>
      </div>
    )
  }

  const view = render(<Probe />)
  try {
    await act(async () => {
      fireEvent.click(view.getByRole('button', { name: 'Paste' }))
    })
    await waitFor(() => expect(mocks.importPaths).toHaveBeenCalledTimes(1))

    clipboardPath = '/source/second.ts'
    await act(async () => {
      fireEvent.click(view.getByRole('button', { name: 'Paste' }))
    })
    clipboardPath = '/source/changed-after-paste.ts'
    releaseFirstImport()
    await waitFor(() => expect(mocks.importPaths).toHaveBeenCalledTimes(2))

    expect(mocks.prepare).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ paths: ['/source/second.ts'] })
    )
  } finally {
    releaseFirstImport()
  }
})
