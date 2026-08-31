// @vitest-environment happy-dom

// Why: the split only happens if a native Explorer drag reaches the layer, so
// these tests drive the real dragstart/dragover/drop gesture end to end.
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WORKSPACE_FILE_PATH_MIME } from '@/lib/workspace-file-drag'
import { resetWorkspaceFileDragActivityForTests } from '@/lib/workspace-file-drag-activity'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

const { createEmptySplitGroupMock, openFileMock, setActiveTabTypeMock, statRuntimePathMock } =
  vi.hoisted(() => ({
    createEmptySplitGroupMock: vi.fn(() => 'new-group'),
    openFileMock: vi.fn(),
    setActiveTabTypeMock: vi.fn(),
    statRuntimePathMock: vi.fn(async () => ({ isDirectory: false, mtime: 0, size: 1 }))
  }))

vi.mock('../../store', () => ({
  useAppStore: {
    getState: () => ({
      createEmptySplitGroup: createEmptySplitGroupMock,
      getKnownWorktreeById: () => ({ path: '/repo' }),
      openFile: openFileMock,
      setActiveTabType: setActiveTabTypeMock
    })
  }
}))
vi.mock('./tab-group-panel-split-target', () => ({
  captureTabGroupPanelGeometrySnapshot: () => ({
    byGroupId: new Map(),
    entries: [{ bodyRect: { height: 200, left: 0, top: 0, width: 400 }, groupId: 'group-1' }]
  })
}))
vi.mock('@/runtime/runtime-file-client', () => ({ statRuntimePath: statRuntimePathMock }))
vi.mock('@/hooks/useGlobalFileDrop', () => ({
  getEditorFileDropOperationContext: () => ({ settings: {}, worktreeId: 'worktree-1' })
}))
vi.mock('@/lib/connection-context', () => ({ getConnectionId: () => undefined }))
vi.mock('@/lib/worktree-runtime-owner', () => ({ getRuntimeEnvironmentIdForWorktree: () => null }))
vi.mock('sonner', () => ({ toast: { error: vi.fn() } }))
vi.mock('@/i18n/i18n', () => ({ translate: (_key: string, fallback: string) => fallback }))

import WorkspaceFileSplitDropLayer from './WorkspaceFileSplitDropLayer'

function dragEvent(type: string, types: string[], point = { x: 0, y: 0 }): Event {
  const event = new Event(type, { bubbles: true, cancelable: true })
  Object.defineProperty(event, 'dataTransfer', {
    value: { dropEffect: 'none', getData: () => '/repo/src/app.ts', types }
  })
  Object.defineProperty(event, 'clientX', { value: point.x })
  Object.defineProperty(event, 'clientY', { value: point.y })
  return event
}

function bands(container: HTMLElement): HTMLElement[] {
  return [...container.querySelectorAll<HTMLElement>('.pointer-events-auto')]
}

/**
 * Mirrors how a real Explorer drag starts: React delegates `onDragStart` to the
 * root, so `setData` lands on the way back up and the payload is still empty
 * while capture-phase listeners run.
 */
function startExplorerDrag(): void {
  const source = document.createElement('div')
  document.body.appendChild(source)
  const types: string[] = []
  const populate = (): void => {
    types.push(WORKSPACE_FILE_PATH_MIME)
  }
  document.body.addEventListener('dragstart', populate)
  source.dispatchEvent(dragEvent('dragstart', types))
  document.body.removeEventListener('dragstart', populate)
  source.remove()
}

describe('WorkspaceFileSplitDropLayer', () => {
  let container: HTMLDivElement
  let root: Root | null = null

  beforeEach(() => {
    vi.clearAllMocks()
    resetWorkspaceFileDragActivityForTests()
    container = document.createElement('div')
    document.body.appendChild(container)
    act(() => {
      root = createRoot(container)
      root.render(<WorkspaceFileSplitDropLayer worktreeId="worktree-1" enabled={true} />)
    })
  })

  afterEach(() => {
    act(() => root?.unmount())
    root = null
    container.remove()
    resetWorkspaceFileDragActivityForTests()
  })

  it('arms one band per split direction from the payload the source sets while bubbling', () => {
    expect(bands(container)).toHaveLength(0)
    act(() => {
      startExplorerDrag()
    })
    expect(bands(container)).toHaveLength(4)
  })

  it('stays inert for drags that carry no workspace file path', () => {
    act(() => {
      window.dispatchEvent(dragEvent('dragstart', ['text/plain']))
    })
    expect(bands(container)).toHaveLength(0)
  })

  it('disarms when the drag ends without a drop', () => {
    act(() => {
      startExplorerDrag()
    })
    act(() => {
      window.dispatchEvent(dragEvent('dragend', [WORKSPACE_FILE_PATH_MIME]))
    })
    expect(bands(container)).toHaveLength(0)
  })

  it('previews the target half while a band is hovered', () => {
    act(() => {
      startExplorerDrag()
    })
    expect(container.querySelector('.tab-drop-overlay')).toBeNull()
    act(() => {
      bands(container)[0]?.dispatchEvent(dragEvent('dragover', [WORKSPACE_FILE_PATH_MIME]))
    })
    expect(container.querySelector('.tab-drop-overlay')).not.toBeNull()
  })

  it('opens the dropped file in a split beside the hovered pane', async () => {
    act(() => {
      startExplorerDrag()
    })
    const rightBand = bands(container)[1]
    await act(async () => {
      rightBand?.dispatchEvent(dragEvent('drop', [WORKSPACE_FILE_PATH_MIME]))
      await Promise.resolve()
    })

    expect(createEmptySplitGroupMock).toHaveBeenCalledWith('worktree-1', 'group-1', 'right')
    expect(setActiveTabTypeMock).toHaveBeenCalledWith('editor')
    expect(openFileMock).toHaveBeenCalledWith(
      expect.objectContaining({ filePath: '/repo/src/app.ts', relativePath: 'src/app.ts' }),
      expect.objectContaining({ targetGroupId: 'new-group' })
    )
  })

  it('leaves folder drops alone instead of opening an empty split', async () => {
    statRuntimePathMock.mockResolvedValueOnce({ isDirectory: true, mtime: 0, size: 0 })
    act(() => {
      startExplorerDrag()
    })
    await act(async () => {
      bands(container)[0]?.dispatchEvent(dragEvent('drop', [WORKSPACE_FILE_PATH_MIME]))
      await Promise.resolve()
    })

    expect(createEmptySplitGroupMock).not.toHaveBeenCalled()
    expect(openFileMock).not.toHaveBeenCalled()
  })
})
