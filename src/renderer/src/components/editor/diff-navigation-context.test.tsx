// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { editor } from 'monaco-editor'
import { useAppStore } from '@/store'
import {
  DiffNavigationProvider,
  useDiffEditorRegistration,
  useDiffNavigation,
  type DiffEditorRegistrationContextValue,
  type DiffNavigationContextValue
} from './diff-navigation-context'

type FakeDiffEditor = editor.IStandaloneDiffEditor & {
  setLineChanges: (count: number) => void
  setCursorLine: (line: number) => void
  fireUpdate: () => void
  goToDiff: ReturnType<typeof vi.fn>
  disposeUpdate: ReturnType<typeof vi.fn>
  containerNode: HTMLElement
}

function createFakeEditor(initialCount: number): FakeDiffEditor {
  let count = initialCount
  let cursorLine = 1
  let updateCallback: (() => void) | null = null
  const disposeUpdate = vi.fn(() => {
    updateCallback = null
  })
  const containerNode = document.createElement('div')
  const editor = {
    // Changes sit at lines 10, 20, 30… so tests can place the cursor before,
    // between, or at the last change to exercise boundary detection.
    getLineChanges: () =>
      count > 0
        ? Array.from({ length: count }, (_unused, i) => ({ modifiedStartLineNumber: (i + 1) * 10 }))
        : [],
    getModifiedEditor: () => ({ getPosition: () => ({ lineNumber: cursorLine, column: 1 }) }),
    goToDiff: vi.fn(),
    getContainerDomNode: () => containerNode,
    onDidUpdateDiff: (cb: () => void) => {
      updateCallback = cb
      return {
        dispose: disposeUpdate
      }
    },
    setLineChanges: (next: number) => {
      count = next
    },
    setCursorLine: (line: number) => {
      cursorLine = line
    },
    fireUpdate: () => updateCallback?.(),
    disposeUpdate,
    containerNode
  } as unknown as FakeDiffEditor
  return editor
}

let captured: DiffNavigationContextValue | null = null
let registration: DiffEditorRegistrationContextValue | null = null
let registrationRenderCount = 0

function Probe(): null {
  captured = useDiffNavigation()
  return null
}

function RegistrationProbe(): null {
  registration = useDiffEditorRegistration()
  registrationRenderCount += 1
  return null
}

describe('DiffNavigationProvider', () => {
  let container: HTMLDivElement | null = null
  let root: Root | null = null

  function mount(): void {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    act(() => {
      root?.render(
        <DiffNavigationProvider>
          <Probe />
          <RegistrationProbe />
        </DiffNavigationProvider>
      )
    })
  }

  afterEach(() => {
    if (root) {
      act(() => root?.unmount())
    }
    container?.remove()
    container = null
    root = null
    captured = null
    registration = null
    registrationRenderCount = 0
    useAppStore.getState().setChangedFileDiffNavigator(null)
  })

  it('exposes the change count and routes nav actions to the registered editor', () => {
    mount()
    const editor = createFakeEditor(3)
    act(() => registration?.registerDiffEditor(editor))

    expect(captured?.changeCount).toBe(3)

    act(() => captured?.goToNextDiff())
    expect(editor.goToDiff).toHaveBeenCalledWith('next')

    act(() => captured?.goToPreviousDiff())
    expect(editor.goToDiff).toHaveBeenCalledWith('previous')
  })

  it('crosses to the adjacent file at the last change, wraps within-file otherwise', () => {
    mount()
    const editor = createFakeEditor(3) // changes at lines 10, 20, 30
    act(() => registration?.registerDiffEditor(editor))

    const navigate = vi.fn(() => true)
    act(() => useAppStore.getState().setChangedFileDiffNavigator(navigate))

    // Cursor between changes: stays within the file (built-in goToDiff).
    act(() => editor.setCursorLine(15))
    act(() => captured?.goToNextDiff())
    expect(navigate).not.toHaveBeenCalled()
    expect(editor.goToDiff).toHaveBeenCalledWith('next')

    // Cursor at the last change: hands off to the next file, no in-file wrap.
    editor.goToDiff.mockClear()
    act(() => editor.setCursorLine(30))
    act(() => captured?.goToNextDiff())
    expect(navigate).toHaveBeenCalledWith('next')
    expect(editor.goToDiff).not.toHaveBeenCalled()

    // No adjacent file (navigator declines): fall back to in-file wrap.
    navigate.mockReturnValue(false)
    editor.goToDiff.mockClear()
    act(() => captured?.goToNextDiff())
    expect(editor.goToDiff).toHaveBeenCalledWith('next')
  })

  it('re-renders when onDidUpdateDiff flips the count 0 -> N (count is state)', () => {
    mount()
    const editor = createFakeEditor(0)
    act(() => registration?.registerDiffEditor(editor))
    expect(captured?.changeCount).toBe(0)

    act(() => {
      editor.setLineChanges(2)
      editor.fireUpdate()
    })
    expect(captured?.changeCount).toBe(2)
    expect(registrationRenderCount).toBe(1)
  })

  it('ignores a stale unregister for an editor that is no longer current (identity guard)', () => {
    mount()
    const oldEditor = createFakeEditor(1)
    const newEditor = createFakeEditor(4)

    // Fast-swap: new editor registers before the old one's dispose fires.
    act(() => registration?.registerDiffEditor(oldEditor))
    act(() => registration?.registerDiffEditor(newEditor))
    expect(captured?.changeCount).toBe(4)
    expect(oldEditor.disposeUpdate).toHaveBeenCalledOnce()

    // A stale update from the old editor must not flip the count back: registering
    // the new editor disposed the old subscription, so its callback no longer fires.
    act(() => {
      oldEditor.setLineChanges(9)
      oldEditor.fireUpdate()
    })
    expect(captured?.changeCount).toBe(4)

    act(() => registration?.unregisterDiffEditor(oldEditor))

    // New editor's count is intact and nav still routes to it.
    expect(captured?.changeCount).toBe(4)
    act(() => captured?.goToNextDiff())
    expect(newEditor.goToDiff).toHaveBeenCalledWith('next')
    expect(oldEditor.goToDiff).not.toHaveBeenCalled()
  })

  it('disposes the active diff update subscription when the provider unmounts', () => {
    mount()
    const editor = createFakeEditor(1)
    act(() => registration?.registerDiffEditor(editor))

    act(() => root?.unmount())

    expect(editor.disposeUpdate).toHaveBeenCalledOnce()
    root = null
  })

  it('installs a capture-phase key listener on register and removes it on unregister', () => {
    mount()
    const editor = createFakeEditor(2)
    const addSpy = vi.spyOn(editor.containerNode, 'addEventListener')
    const removeSpy = vi.spyOn(editor.containerNode, 'removeEventListener')

    act(() => registration?.registerDiffEditor(editor))
    expect(addSpy).toHaveBeenCalledWith('keydown', expect.any(Function), true)

    act(() => registration?.unregisterDiffEditor(editor))
    expect(removeSpy).toHaveBeenCalledWith('keydown', expect.any(Function), true)
  })
})
