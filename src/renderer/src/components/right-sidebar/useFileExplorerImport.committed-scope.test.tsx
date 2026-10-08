// @vitest-environment happy-dom
import { Suspense, startTransition } from 'react'
import { act, cleanup, render, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { useFileExplorerImport } from './useFileExplorerImport'

const mocks = vi.hoisted(() => ({ importPaths: vi.fn(), prepare: vi.fn() }))
vi.mock('@/runtime/runtime-file-client', () => ({
  importExternalPathsToRuntime: mocks.importPaths
}))
vi.mock('./file-explorer-operation-owner', () => ({
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
    const ownerRef = useFileExplorerImport({
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
      <div ref={ownerRef}>
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
