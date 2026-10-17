// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { dispatchAppMenuPasteEvent, handleAppMenuPasteRequest } from '@/lib/app-menu-paste'
import { useFileExplorerImagePaste } from './use-file-explorer-image-paste'
import { useFileExplorerPasteEvents } from './use-file-explorer-paste-events'
import { createFileExplorerRowProjection } from './file-explorer-row-projection'
import type { TreeNode } from './file-explorer-types'

const mocks = vi.hoisted(() => ({ stage: vi.fn(), release: vi.fn(), importPaths: vi.fn() }))
const state = vi.hoisted(() => ({
  rightSidebarOpen: true,
  rightSidebarTab: 'explorer',
  rightSidebarExplorerView: 'files'
}))
vi.mock('@/store', () => ({
  useAppStore: (selector: (value: typeof state) => unknown) => selector(state)
}))
vi.mock('@/runtime/runtime-file-import-client', () => ({
  importExternalPathsToRuntime: mocks.importPaths
}))
vi.mock('./file-explorer-operation-owner', () => ({
  captureFileExplorerOperationGuard: () => ({
    route: { target: { kind: 'local' }, expectedExecutionHostId: 'local' },
    assertCurrent: () => {}
  })
}))

const owner = { kind: 'local' } as const
const folder: TreeNode = {
  name: 'focused',
  path: '/notes/images/focused',
  relativePath: 'images/focused',
  isDirectory: true,
  depth: 1,
  operationOwner: owner
}
const selected = { ...folder, path: '/notes/images/selected' }
let container: HTMLDivElement
let row: HTMLButtonElement

function setup(options: { selectedNode?: TreeNode | null; isEditing?: boolean } = {}) {
  return renderHook(() => {
    const imagePaste = useFileExplorerImagePaste({
      worktreeId: 'folder:notes',
      worktreePath: '/notes',
      displayRootPath: '/notes/images',
      selectedNode: options.selectedNode ?? null,
      operationOwner: owner,
      refreshDir: vi.fn().mockResolvedValue(undefined),
      setSelectedPath: vi.fn()
    })
    useFileExplorerPasteEvents({
      containerRef: { current: container },
      rowProjection: createFileExplorerRowProjection([folder]),
      selectedNode: options.selectedNode ?? null,
      isEditing: options.isEditing ?? false,
      imagePaste
    })
    return imagePaste
  })
}

function key(overrides: KeyboardEventInit = {}): KeyboardEvent {
  const event = new KeyboardEvent('keydown', {
    key: 'v',
    ctrlKey: true,
    bubbles: true,
    cancelable: true,
    ...overrides
  })
  document.activeElement?.dispatchEvent(event)
  return event
}
function paste(): Event {
  const event = new Event('paste', { bubbles: true, cancelable: true })
  document.activeElement?.dispatchEvent(event)
  return event
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.resetAllMocks()
  Object.assign(state, {
    rightSidebarOpen: true,
    rightSidebarTab: 'explorer',
    rightSidebarExplorerView: 'files'
  })
  vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Windows')
  mocks.stage.mockResolvedValue({ handle: 'handle', path: '/stage/pasted-image.png' })
  mocks.release.mockResolvedValue(true)
  mocks.importPaths.mockResolvedValue({ results: [] })
  vi.stubGlobal('api', {
    ui: { stageClipboardImageForImport: mocks.stage, releaseClipboardImageImport: mocks.release }
  })
  container = document.createElement('div')
  container.tabIndex = -1
  const wrapper = document.createElement('div')
  wrapper.dataset.index = '0'
  row = document.createElement('button')
  wrapper.append(row)
  container.append(wrapper)
  document.body.append(container)
  row.focus()
})
afterEach(() => {
  cleanup()
  document.body.replaceChildren()
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

it.each(['Windows', 'Macintosh', 'Linux'])(
  'pastes once via the %s modifier into the focused row',
  async (platform) => {
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(platform)
    setup({ selectedNode: selected })
    await act(async () => {
      expect(
        key({ ctrlKey: platform !== 'Macintosh', metaKey: platform === 'Macintosh' })
          .defaultPrevented
      ).toBe(true)
    })
    expect(mocks.importPaths).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ worktreeId: 'folder:notes', worktreePath: '/notes' }),
      ['/stage/pasted-image.png'],
      folder.path,
      expect.objectContaining({ requireExistingDestination: true })
    )
  }
)

it.each([null, selected])(
  'uses the selection or displayed root when no row is focused (%s)',
  async (selectedNode) => {
    container.focus()
    setup({ selectedNode })
    await act(async () => {
      paste()
    })
    expect(mocks.importPaths.mock.calls[0][2]).toBe(selectedNode?.path ?? '/notes/images')
  }
)

it('claims the native menu before text reads or native fallback', async () => {
  setup()
  const readClipboardText = vi.fn()
  const performNativePaste = vi.fn()
  await act(async () => {
    expect(await handleAppMenuPasteRequest({ readClipboardText, performNativePaste })).toEqual({
      status: 'handled',
      target: 'owned-target'
    })
  })
  expect(mocks.stage).toHaveBeenCalledTimes(1)
  expect(readClipboardText).not.toHaveBeenCalled()
  expect(performNativePaste).not.toHaveBeenCalled()
})

it('deduplicates key, menu and paste events even after a fast import completes', async () => {
  setup()
  await act(async () => {
    key()
  })
  await act(async () => {
    expect(dispatchAppMenuPasteEvent()).toBe(true)
    expect(paste().defaultPrevented).toBe(true)
  })
  expect(mocks.stage).toHaveBeenCalledTimes(1)
  act(() => vi.runAllTimers())
  await act(async () => {
    key()
  })
  expect(mocks.stage).toHaveBeenCalledTimes(2)
})

it('consumes overlapping gestures during cleanup without staging twice', async () => {
  let finish = () => {}
  mocks.release.mockReturnValue(
    new Promise<void>((resolve) => {
      finish = resolve
    })
  )
  const { result } = setup()
  await act(async () => {
    paste()
  })
  expect(result.current.isPastingImage).toBe(true)
  act(() => vi.runAllTimers())
  await act(async () => {
    expect(key().defaultPrevented).toBe(true)
    expect(dispatchAppMenuPasteEvent()).toBe(true)
    finish()
  })
  expect(mocks.stage).toHaveBeenCalledTimes(1)
})

it.each([
  'input',
  'textarea',
  'select',
  'contenteditable',
  'ignored-button',
  'outside',
  'terminal'
])('preserves paste with focus on %s', async (kind) => {
  const target = document.createElement(
    kind === 'input' || kind === 'textarea' || kind === 'select' ? kind : 'div'
  )
  target.tabIndex = 0
  if (kind === 'contenteditable') {
    target.setAttribute('contenteditable', 'true')
  }
  if (kind === 'ignored-button') {
    target.dataset.ignoreFileExplorerKeys = 'true'
  }
  if (kind === 'terminal') {
    target.className = 'xterm-helper-textarea'
  }
  ;(kind === 'outside' || kind === 'terminal' ? document.body : container).append(target)
  target.focus()
  setup({ selectedNode: selected })
  await act(async () => {
    expect(key().defaultPrevented).toBe(false)
    expect(paste().defaultPrevented).toBe(false)
    expect(dispatchAppMenuPasteEvent()).toBe(false)
  })
  expect(mocks.stage).not.toHaveBeenCalled()
})

it.each(['closed', 'other-tab', 'search', 'editing', 'web', 'missing-release'])(
  'does not claim events when %s',
  async (condition) => {
    if (condition === 'closed') {
      state.rightSidebarOpen = false
    }
    if (condition === 'other-tab') {
      state.rightSidebarTab = 'changes'
    }
    if (condition === 'search') {
      state.rightSidebarExplorerView = 'search'
    }
    if (condition === 'web') {
      vi.stubGlobal('api', { ui: {} })
    }
    if (condition === 'missing-release') {
      vi.stubGlobal('api', { ui: { stageClipboardImageForImport: mocks.stage } })
    }
    setup({ isEditing: condition === 'editing' })
    await act(async () => {
      expect(key().defaultPrevented).toBe(false)
      expect(paste().defaultPrevented).toBe(false)
      expect(dispatchAppMenuPasteEvent()).toBe(false)
    })
    expect(mocks.stage).not.toHaveBeenCalled()
  }
)

it.each([
  { altKey: true },
  { shiftKey: true },
  { ctrlKey: false, metaKey: true },
  { ctrlKey: false },
  { isComposing: true },
  { key: 'c' },
  { repeat: true }
])('does not stage for a different chord, composition or repeat (%s)', async (overrides) => {
  setup()
  await act(async () => {
    key(overrides)
  })
  expect(mocks.stage).not.toHaveBeenCalled()
})

it('does nothing for non-image content and removes listeners on unmount', async () => {
  mocks.stage.mockResolvedValue(null)
  const { unmount } = setup()
  await act(async () => {
    key()
  })
  expect(mocks.importPaths).not.toHaveBeenCalled()
  expect(mocks.release).not.toHaveBeenCalled()
  unmount()
  expect(key().defaultPrevented).toBe(false)
  expect(dispatchAppMenuPasteEvent()).toBe(false)
  expect(vi.getTimerCount()).toBe(0)
})
