// @vitest-environment happy-dom
import { Suspense, startTransition } from 'react'
import { act, cleanup, render, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { useFileExplorerImport } from './useFileExplorerImport'

const mocks = vi.hoisted(() => ({ importPaths: vi.fn(), subscribe: vi.fn() }))
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

it('keeps native drops on committed scope when a new scope render suspends', async () => {
  vi.stubGlobal('api', { ui: { onFileDrop: mocks.subscribe } })
  const selected = vi.fn()
  const clearDrag = vi.fn()
  const refresh = vi.fn().mockResolvedValue(undefined)
  const suspended = new Promise<void>(() => {})
  mocks.subscribe.mockReturnValue(vi.fn())
  mocks.importPaths.mockResolvedValue({
    results: [{ status: 'imported', destPath: '/repo/app/file.ts' }]
  })

  function Probe({ scope, suspend = false }: { scope: string; suspend?: boolean }) {
    useFileExplorerImport({
      activeWorktreeId: 'wt',
      worktreePath: '/repo',
      displayRootPath: scope,
      refreshDir: refresh,
      clearNativeDragState: clearDrag,
      setSelectedPath: selected
    })
    if (suspend) {
      throw suspended
    }
    return <span>{scope}</span>
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
  const drop = mocks.subscribe.mock.calls[0][0]
  await act(async () => {
    drop({ target: 'file-explorer', paths: ['/source/file.ts'], destinationDir: '/repo/app' })
  })
  await waitFor(() => expect(selected).toHaveBeenCalledWith('/repo/app/file.ts'))
  expect(refresh).toHaveBeenCalledWith('/repo/app')

  selected.mockClear()
  view.rerender(
    <Suspense fallback="Loading">
      <Probe scope="/repo/api" />
    </Suspense>
  )
  await act(async () => {
    drop({ target: 'file-explorer', paths: ['/source/file.ts'], destinationDir: '/repo/app' })
  })
  await waitFor(() => expect(clearDrag).toHaveBeenCalledTimes(2))
  expect(selected).not.toHaveBeenCalled()
  expect(mocks.subscribe).toHaveBeenCalledTimes(1)
})
