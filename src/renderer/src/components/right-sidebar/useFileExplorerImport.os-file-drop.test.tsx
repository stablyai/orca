// @vitest-environment happy-dom
import { act, cleanup, render, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PreparedDroppedPaths } from '../../../../shared/native-file-drop-preparation'
import { WORKSPACE_FILE_PATH_MIME } from '@/lib/workspace-file-drag'
import { useFileExplorerImport } from './useFileExplorerImport'
import { useFileExplorerRowDrag } from './useFileExplorerRowDrag'

const mocks = vi.hoisted(() => ({
  importPaths: vi.fn(),
  captureGuard: vi.fn(),
  prepare: vi.fn()
}))
vi.mock('@/runtime/runtime-file-client', () => ({
  importExternalPathsToRuntime: mocks.importPaths
}))
vi.mock('./file-explorer-operation-owner', () => ({
  captureFileExplorerOperationGuard: mocks.captureGuard
}))
vi.mock('sonner', () => ({ toast: { error: vi.fn() } }))

type Scope = { worktreeId: string; worktreePath: string; displayRootPath: string }
type Row = { path: string; dropDir: string }

const refreshDir = vi.fn().mockResolvedValue(undefined)
const clearDrag = vi.fn()
const setSelected = vi.fn()

function Explorer({ scope, rows }: { scope: Scope; rows: Row[] }): React.JSX.Element {
  const ownerRef = useFileExplorerImport({
    ...scope,
    refreshDir,
    clearNativeDragState: clearDrag,
    setSelectedPath: setSelected
  })
  return (
    <div ref={ownerRef} data-testid="tree">
      {rows.map((row) => (
        <button key={row.path} data-testid={row.path} data-file-explorer-drop-dir={row.dropDir}>
          <span data-testid={`${row.path}:label`} />
        </button>
      ))}
    </div>
  )
}

function drag(
  target: Element,
  type: 'dragover' | 'drop',
  types: string[] = ['Files']
): { dropEffect: string } {
  const transfer = {
    types,
    files: [new File(['a'], 'a.txt')],
    dropEffect: 'move',
    getData: (format: string) => (format === WORKSPACE_FILE_PATH_MIME ? '/repo/app/moved.ts' : '')
  }
  const event = new Event(type, { bubbles: true, cancelable: true, composed: true })
  Object.defineProperty(event, 'dataTransfer', { value: transfer })
  Object.defineProperty(event, 'isTrusted', { value: true })
  act(() => {
    target.dispatchEvent(event)
  })
  return transfer
}

function deferredPreparation(): (paths: string[]) => void {
  let resolve: (prepared: PreparedDroppedPaths) => void = () => undefined
  mocks.prepare.mockImplementationOnce(
    () => new Promise<PreparedDroppedPaths>((done) => (resolve = done))
  )
  return (paths) => resolve({ paths, failures: [] })
}

const SCOPE_B: Scope = { worktreeId: 'wt-b', worktreePath: '/repo', displayRootPath: '/repo/app' }
const ROWS: Row[] = [
  { path: '/repo/app/src', dropDir: '/repo/app/src' },
  { path: '/repo/app/README.md', dropDir: '/repo/app' }
]

beforeEach(() => {
  mocks.prepare.mockImplementation(async ({ paths }: { paths: string[] }) => ({
    paths,
    failures: []
  }))
  mocks.captureGuard.mockImplementation(() => ({
    route: { settings: { activeRuntimeEnvironmentId: null }, expectedExecutionHostId: 'local' },
    assertCurrent: vi.fn()
  }))
  mocks.importPaths.mockResolvedValue({
    results: [{ status: 'imported', destPath: '/repo/app/src/a.txt' }]
  })
  vi.stubGlobal('api', {
    fs: {
      getPathForFile: (file: File) => `/source/${file.name}`,
      prepareDroppedPaths: mocks.prepare
    }
  })
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})

describe('file explorer OS file drops', () => {
  it('imports a drop on a folder row into that folder', async () => {
    const view = render(<Explorer scope={SCOPE_B} rows={ROWS} />)
    expect(drag(view.getByTestId('/repo/app/src:label'), 'dragover').dropEffect).toBe('copy')
    drag(view.getByTestId('/repo/app/src:label'), 'drop')
    await waitFor(() => expect(mocks.importPaths).toHaveBeenCalledTimes(1))
    expect(mocks.prepare).toHaveBeenCalledWith({
      paths: ['/source/a.txt'],
      consumer: 'main-reader'
    })
    expect(mocks.importPaths.mock.calls[0][1]).toEqual(['/source/a.txt'])
    expect(mocks.importPaths.mock.calls[0][2]).toBe('/repo/app/src')
    await waitFor(() => expect(setSelected).toHaveBeenCalledWith('/repo/app/src/a.txt'))
    expect(refreshDir).toHaveBeenCalledWith('/repo/app/src')
    expect(clearDrag).toHaveBeenCalled()
  })

  it('imports a drop on the empty tree area into the displayed root', async () => {
    const view = render(<Explorer scope={SCOPE_B} rows={[]} />)
    drag(view.getByTestId('tree'), 'drop')
    await waitFor(() => expect(mocks.importPaths).toHaveBeenCalledTimes(1))
    expect(mocks.importPaths.mock.calls[0][2]).toBe('/repo/app')
  })

  it('captures the target folder at drop time even if rows re-render during preparation', async () => {
    const finishPreparation = deferredPreparation()
    const view = render(<Explorer scope={SCOPE_B} rows={ROWS} />)
    drag(view.getByTestId('/repo/app/src:label'), 'drop')
    // A virtualized list recycles the row under the cursor for another node.
    view.rerender(
      <Explorer scope={SCOPE_B} rows={[{ path: '/repo/app/lib', dropDir: '/repo/app/lib' }]} />
    )
    await act(async () => finishPreparation(['/source/a.txt']))
    await waitFor(() => expect(mocks.importPaths).toHaveBeenCalledTimes(1))
    expect(mocks.importPaths.mock.calls[0][2]).toBe('/repo/app/src')
  })

  it('imports into the workspace the drop landed on, not the one shown after preparation', async () => {
    const finishPreparation = deferredPreparation()
    const view = render(<Explorer scope={SCOPE_B} rows={ROWS} />)
    drag(view.getByTestId('/repo/app/src:label'), 'drop')
    const scopeA = { worktreeId: 'wt-a', worktreePath: '/other', displayRootPath: '/other' }
    view.rerender(<Explorer scope={scopeA} rows={[]} />)
    await act(async () => finishPreparation(['/source/a.txt']))
    await waitFor(() => expect(mocks.importPaths).toHaveBeenCalledTimes(1))
    expect(mocks.captureGuard).toHaveBeenCalledTimes(1)
    expect(mocks.captureGuard.mock.calls[0][0]).toBe('wt-b')
    expect(mocks.importPaths.mock.calls[0][0]).toMatchObject({
      worktreeId: 'wt-b',
      worktreePath: '/repo'
    })
    expect(mocks.importPaths.mock.calls[0][2]).toBe('/repo/app/src')
    // The explorer now shows workspace A, so the B result is not selected there.
    await waitFor(() => expect(clearDrag).toHaveBeenCalled())
    expect(setSelected).not.toHaveBeenCalled()
  })

  it('refuses a drop on a row outside the displayed root', () => {
    const view = render(
      <Explorer scope={SCOPE_B} rows={[{ path: '/repo/api/x', dropDir: '/repo/api' }]} />
    )
    expect(drag(view.getByTestId('/repo/api/x'), 'dragover').dropEffect).toBe('none')
    drag(view.getByTestId('/repo/api/x'), 'drop')
    expect(mocks.prepare).not.toHaveBeenCalled()
    expect(mocks.importPaths).not.toHaveBeenCalled()
  })

  it('refuses while the files view is hidden', () => {
    const hidden = { worktreeId: 'wt-b', worktreePath: null, displayRootPath: '/repo/app' }
    function HiddenExplorer(): React.JSX.Element {
      const ownerRef = useFileExplorerImport({
        ...hidden,
        refreshDir,
        clearNativeDragState: clearDrag,
        setSelectedPath: setSelected
      })
      return <div ref={ownerRef} data-testid="tree" />
    }
    const view = render(<HiddenExplorer />)
    expect(drag(view.getByTestId('tree'), 'dragover').dropEffect).toBe('none')
    drag(view.getByTestId('tree'), 'drop')
    expect(mocks.prepare).not.toHaveBeenCalled()
  })
})

describe('internal explorer row drags under the OS-drop owner', () => {
  function DraggableRow({ onMoveDrop }: { onMoveDrop: (source: string, dir: string) => void }) {
    const handlers = useFileExplorerRowDrag({
      rowDropDir: '/repo/app/src',
      isDirectory: true,
      nodePath: '/repo/app/src',
      isExpanded: true,
      onDragTargetChange: vi.fn(),
      onDragExpandDir: vi.fn(),
      onNativeDragTargetChange: vi.fn(),
      onNativeDragExpandDir: vi.fn(),
      onMoveDrop
    })
    return (
      <button
        data-testid="row"
        data-file-explorer-drop-dir="/repo/app/src"
        onDragOver={handlers.handleDragOver}
        onDrop={handlers.handleDrop}
      />
    )
  }
  function ExplorerWithRow({ onMoveDrop }: { onMoveDrop: (source: string, dir: string) => void }) {
    const ownerRef = useFileExplorerImport({
      ...SCOPE_B,
      refreshDir,
      clearNativeDragState: clearDrag,
      setSelectedPath: setSelected
    })
    return (
      <div ref={ownerRef}>
        <DraggableRow onMoveDrop={onMoveDrop} />
      </div>
    )
  }

  it('still moves a row dragged onto a folder row', () => {
    const onMoveDrop = vi.fn()
    const view = render(<ExplorerWithRow onMoveDrop={onMoveDrop} />)
    expect(drag(view.getByTestId('row'), 'dragover', [WORKSPACE_FILE_PATH_MIME]).dropEffect).toBe(
      'move'
    )
    drag(view.getByTestId('row'), 'drop', [WORKSPACE_FILE_PATH_MIME])
    expect(onMoveDrop).toHaveBeenCalledWith('/repo/app/moved.ts', '/repo/app/src')
    expect(mocks.prepare).not.toHaveBeenCalled()
    expect(mocks.importPaths).not.toHaveBeenCalled()
  })
})
