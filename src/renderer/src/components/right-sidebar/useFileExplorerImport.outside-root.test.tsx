// @vitest-environment happy-dom
import { act, cleanup, render } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { useFileExplorerImport } from './useFileExplorerImport'

const mocks = vi.hoisted(() => ({ importPaths: vi.fn(), prepare: vi.fn() }))
vi.mock('@/runtime/runtime-file-import-client', () => ({
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

it('takes native drops only on workspace folders while an outside ancestor is shown', async () => {
  vi.stubGlobal('api', {
    fs: {
      getPathForFile: () => '/source/file.ts',
      prepareDroppedPaths: mocks.prepare.mockImplementation(async ({ paths }) => ({
        paths,
        failures: []
      }))
    }
  })
  const refresh = vi.fn().mockResolvedValue(undefined)
  mocks.importPaths.mockResolvedValue({
    results: [{ status: 'imported', destPath: '/home/repo/src/file.ts' }]
  })

  function Probe() {
    const ownerRef = useFileExplorerImport({
      worktreeId: 'wt',
      worktreePath: '/home/repo',
      displayRootPath: '/home',
      refreshDir: refresh,
      clearNativeDragState: vi.fn(),
      setSelectedPath: vi.fn()
    })
    return (
      <div ref={ownerRef}>
        <span data-testid="background">background</span>
        <span data-testid="workspace-row" data-file-explorer-drop-dir="/home/repo/src">
          src
        </span>
      </div>
    )
  }
  const view = render(<Probe />)

  let transfer: { dropEffect: string } | undefined
  await act(async () => {
    transfer = dropOn(view.getByTestId('background'))
  })
  // The background is the outside root /home, which the explorer shows read-only.
  expect(transfer?.dropEffect).toBe('none')
  expect(mocks.importPaths).not.toHaveBeenCalled()

  await act(async () => {
    dropOn(view.getByTestId('workspace-row'))
  })
  expect(mocks.importPaths).toHaveBeenCalledTimes(1)
  expect(mocks.importPaths.mock.calls[0][2]).toBe('/home/repo/src')
  expect(refresh).toHaveBeenCalledWith('/home/repo/src')
})
