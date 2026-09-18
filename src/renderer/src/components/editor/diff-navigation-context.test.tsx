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
import type { WorktreeDiffNavigationDirection } from './worktree-diff-file-navigation'

type FakeLineChange = {
  modifiedStartLineNumber: number
  modifiedEndLineNumber: number
}

type FakeDiffEditor = editor.IStandaloneDiffEditor & {
  setLineChanges: (changes: number | FakeLineChange[]) => void
  setPosition: (position: { lineNumber: number; column: number } | null) => void
  fireUpdate: () => void
  goToDiff: ReturnType<typeof vi.fn>
  disposeUpdate: ReturnType<typeof vi.fn>
  containerNode: HTMLElement
}

function makeLineChanges(count: number): FakeLineChange[] {
  return Array.from({ length: count }, (_, index) => ({
    modifiedStartLineNumber: 10 + index * 10,
    modifiedEndLineNumber: 10 + index * 10
  }))
}

function createFakeEditor(initialChanges: number | FakeLineChange[]): FakeDiffEditor {
  let changes = Array.isArray(initialChanges) ? initialChanges : makeLineChanges(initialChanges)
  let position: { lineNumber: number; column: number } | null = { lineNumber: 1, column: 1 }
  let updateCallback: (() => void) | null = null
  const disposeUpdate = vi.fn(() => {
    updateCallback = null
  })
  const containerNode = document.createElement('div')
  const diffEditor = {
    getLineChanges: () => changes,
    goToDiff: vi.fn(),
    getModifiedEditor: () => ({ getPosition: () => position }),
    getContainerDomNode: () => containerNode,
    onDidUpdateDiff: (cb: () => void) => {
      updateCallback = cb
      return {
        dispose: disposeUpdate
      }
    },
    setLineChanges: (next: number | FakeLineChange[]) => {
      changes = Array.isArray(next) ? next : makeLineChanges(next)
    },
    setPosition: (next: { lineNumber: number; column: number } | null) => {
      position = next
    },
    fireUpdate: () => updateCallback?.(),
    disposeUpdate,
    containerNode
  } as unknown as FakeDiffEditor
  return diffEditor
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

  function mount(props: {
    canNavigateFile?: boolean
    onNavigateFile?: (direction: WorktreeDiffNavigationDirection) => boolean
  } = {}): void {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    act(() => {
      root?.render(
        <DiffNavigationProvider {...props}>
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
    expect(captured?.canNavigate).toBe(true)

    act(() => captured?.goToNextDiff())
    expect(editor.goToDiff).toHaveBeenCalledWith('next')

    editor.setPosition({ lineNumber: 99, column: 1 })
    act(() => captured?.goToPreviousDiff())
    expect(editor.goToDiff).toHaveBeenCalledWith('previous')
  })

  it('hands next navigation to a file callback after the last hunk', () => {
    const onNavigateFile = vi.fn(() => true)
    mount({ canNavigateFile: true, onNavigateFile })
    const editor = createFakeEditor([
      { modifiedStartLineNumber: 10, modifiedEndLineNumber: 10 },
      { modifiedStartLineNumber: 20, modifiedEndLineNumber: 20 }
    ])
    act(() => registration?.registerDiffEditor(editor))

    act(() => captured?.goToNextDiff())
    expect(editor.goToDiff).toHaveBeenCalledWith('next')
    expect(onNavigateFile).not.toHaveBeenCalled()

    editor.setPosition({ lineNumber: 99, column: 1 })
    act(() => captured?.goToNextDiff())
    expect(onNavigateFile).toHaveBeenCalledWith('next')
  })

  it('hands previous navigation to a file callback before the first hunk', () => {
    const onNavigateFile = vi.fn(() => true)
    mount({ canNavigateFile: true, onNavigateFile })
    const editor = createFakeEditor([{ modifiedStartLineNumber: 10, modifiedEndLineNumber: 10 }])
    act(() => registration?.registerDiffEditor(editor))

    act(() => captured?.goToPreviousDiff())

    expect(onNavigateFile).toHaveBeenCalledWith('previous')
    expect(editor.goToDiff).not.toHaveBeenCalled()
  })

  it('hands off immediately when the registered diff has no text hunks', () => {
    const onNavigateFile = vi.fn(() => true)
    mount({ canNavigateFile: true, onNavigateFile })
    const editor = createFakeEditor(0)
    act(() => registration?.registerDiffEditor(editor))

    expect(captured?.changeCount).toBe(0)
    expect(captured?.canNavigate).toBe(true)
    act(() => captured?.goToNextDiff())

    expect(onNavigateFile).toHaveBeenCalledWith('next')
    expect(editor.goToDiff).not.toHaveBeenCalled()
  })

  it('does not move the current editor when the file callback cannot navigate', () => {
    const onNavigateFile = vi.fn(() => false)
    mount({ canNavigateFile: true, onNavigateFile })
    const editor = createFakeEditor([{ modifiedStartLineNumber: 10, modifiedEndLineNumber: 10 }])
    editor.setPosition({ lineNumber: 99, column: 1 })
    act(() => registration?.registerDiffEditor(editor))

    act(() => captured?.goToNextDiff())

    expect(onNavigateFile).toHaveBeenCalledWith('next')
    expect(editor.goToDiff).not.toHaveBeenCalled()
  })

  it('reveals pending next navigation after the replacement editor updates', () => {
    const onNavigateFile = vi.fn(() => true)
    mount({ canNavigateFile: true, onNavigateFile })
    const oldEditor = createFakeEditor([{ modifiedStartLineNumber: 10, modifiedEndLineNumber: 10 }])
    oldEditor.setPosition({ lineNumber: 99, column: 1 })
    act(() => registration?.registerDiffEditor(oldEditor))
    act(() => captured?.goToNextDiff())

    const newEditor = createFakeEditor(0)
    act(() => registration?.registerDiffEditor(newEditor))
    expect(newEditor.goToDiff).not.toHaveBeenCalled()

    act(() => {
      newEditor.setLineChanges(2)
      newEditor.fireUpdate()
    })

    expect(newEditor.goToDiff).toHaveBeenCalledOnce()
    expect(newEditor.goToDiff).toHaveBeenCalledWith('next')
    act(() => newEditor.fireUpdate())
    expect(newEditor.goToDiff).toHaveBeenCalledOnce()
  })

  it('reveals pending previous navigation after the replacement editor updates', () => {
    const onNavigateFile = vi.fn(() => true)
    mount({ canNavigateFile: true, onNavigateFile })
    const oldEditor = createFakeEditor([{ modifiedStartLineNumber: 10, modifiedEndLineNumber: 10 }])
    act(() => registration?.registerDiffEditor(oldEditor))
    act(() => captured?.goToPreviousDiff())

    const newEditor = createFakeEditor(0)
    act(() => registration?.registerDiffEditor(newEditor))
    act(() => {
      newEditor.setLineChanges(2)
      newEditor.fireUpdate()
    })

    expect(newEditor.goToDiff).toHaveBeenCalledWith('previous')
  })

  it('reveals pending navigation when the replacement editor is already computed at registration', () => {
    const onNavigateFile = vi.fn(() => true)
    mount({ canNavigateFile: true, onNavigateFile })
    const oldEditor = createFakeEditor([{ modifiedStartLineNumber: 10, modifiedEndLineNumber: 10 }])
    oldEditor.setPosition({ lineNumber: 99, column: 1 })
    act(() => registration?.registerDiffEditor(oldEditor))
    act(() => captured?.goToNextDiff())

    const newEditor = createFakeEditor(2)
    act(() => registration?.registerDiffEditor(newEditor))

    expect(newEditor.goToDiff).toHaveBeenCalledOnce()
    expect(newEditor.goToDiff).toHaveBeenCalledWith('next')
  })

  it('clears pending reveal for a computed empty diff', () => {
    const onNavigateFile = vi.fn(() => true)
    mount({ canNavigateFile: true, onNavigateFile })
    const oldEditor = createFakeEditor(0)
    act(() => registration?.registerDiffEditor(oldEditor))
    act(() => captured?.goToNextDiff())

    const newEditor = createFakeEditor(0)
    act(() => registration?.registerDiffEditor(newEditor))
    act(() => newEditor.fireUpdate())
    act(() => {
      newEditor.setLineChanges(1)
      newEditor.fireUpdate()
    })

    expect(newEditor.goToDiff).not.toHaveBeenCalled()
  })

  it('re-renders when onDidUpdateDiff flips the count 0 -> N (count is state)', () => {
    mount()
    const editor = createFakeEditor(0)
    act(() => registration?.registerDiffEditor(editor))
    expect(captured?.changeCount).toBe(0)
    expect(captured?.canNavigate).toBe(false)

    act(() => {
      editor.setLineChanges(2)
      editor.fireUpdate()
    })
    expect(captured?.changeCount).toBe(2)
    expect(captured?.canNavigate).toBe(true)
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
