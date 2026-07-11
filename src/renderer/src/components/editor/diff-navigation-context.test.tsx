// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { editor } from 'monaco-editor'
import {
  DiffNavigationProvider,
  useDiffEditorRegistration,
  useDiffNavigation,
  type DiffEditorRegistrationContextValue,
  type DiffNavigationContextValue
} from './diff-navigation-context'

type FakeDiffEditor = editor.IStandaloneDiffEditor & {
  setLineChanges: (count: number) => void
  fireUpdate: () => void
  goToDiff: ReturnType<typeof vi.fn>
  disposeUpdate: ReturnType<typeof vi.fn>
  containerNode: HTMLElement
}

function createFakeEditor(initialCount: number): FakeDiffEditor {
  let count = initialCount
  let updateCallback: (() => void) | null = null
  const disposeUpdate = vi.fn(() => {
    updateCallback = null
  })
  const containerNode = document.createElement('div')
  const editor = {
    getLineChanges: () => (count > 0 ? Array.from({ length: count }, () => ({})) : []),
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
