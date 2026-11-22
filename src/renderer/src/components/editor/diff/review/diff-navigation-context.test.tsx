// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
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
  setLineChanges: (changes: FakeLineChange[]) => void
  setPosition: (lineNumber: number) => void
  setLineCount: (lineCount: number) => void
  fireUpdate: () => void
  goToDiff: ReturnType<typeof vi.fn>
  disposeUpdate: ReturnType<typeof vi.fn>
  containerNode: HTMLElement
}

function createFakeEditor(changes: FakeLineChange[]): FakeDiffEditor {
  let currentChanges = changes
  let positionLineNumber = 1
  let lineCount = 200
  let updateCallback: (() => void) | null = null
  const disposeUpdate = vi.fn(() => {
    updateCallback = null
  })
  const containerNode = document.createElement('div')
  const fake = {
    getLineChanges: () => currentChanges,
    goToDiff: vi.fn(),
    getModifiedEditor: () => ({
      getPosition: () => ({ lineNumber: positionLineNumber, column: 1 }),
      getModel: () => ({ getLineCount: () => lineCount })
    }),
    getContainerDomNode: () => containerNode,
    onDidUpdateDiff: (cb: () => void) => {
      updateCallback = cb
      return { dispose: disposeUpdate }
    },
    setLineChanges: (next: FakeLineChange[]) => {
      currentChanges = next
    },
    setPosition: (lineNumber: number) => {
      positionLineNumber = lineNumber
    },
    setLineCount: (count: number) => {
      lineCount = count
    },
    fireUpdate: () => updateCallback?.(),
    disposeUpdate,
    containerNode
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: partial monaco fake exposing only the navigation-relevant surface.
  return fake as unknown as FakeDiffEditor
}

const change = (start: number, end = start): FakeLineChange => ({
  modifiedStartLineNumber: start,
  modifiedEndLineNumber: end
})
// Pure deletions collapse to (anchor - 1, 0) in the deprecated getLineChanges shape.
const deletion = (anchor: number): FakeLineChange => ({
  modifiedStartLineNumber: anchor - 1,
  modifiedEndLineNumber: 0
})

let captured: DiffNavigationContextValue | null = null
let registration: DiffEditorRegistrationContextValue | null = null

function Probe(): React.JSX.Element {
  captured = useDiffNavigation()
  registration = useDiffEditorRegistration()
  return <div data-probe />
}

describe('DiffNavigationProvider', () => {
  let container: HTMLDivElement | null = null
  let root: Root | null = null

  function mount(
    props: {
      canNavigateFile?: boolean
      onNavigateFile?: (direction: WorktreeDiffNavigationDirection) => boolean
      arrivalReveal?: WorktreeDiffNavigationDirection | null
    } = {}
  ): void {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    rerender(props)
  }

  function rerender(
    props: {
      canNavigateFile?: boolean
      onNavigateFile?: (direction: WorktreeDiffNavigationDirection) => boolean
      arrivalReveal?: WorktreeDiffNavigationDirection | null
    } = {}
  ): void {
    act(() => {
      root?.render(
        <DiffNavigationProvider {...props}>
          <Probe />
        </DiffNavigationProvider>
      )
    })
  }

  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    captured = null
    registration = null
  })

  afterEach(async () => {
    if (root) {
      await act(async () => root?.unmount())
    }
    container?.remove()
    captured = null
    registration = null
  })

  it('visits a deletion hunk anchored below the cursor instead of skipping the file', () => {
    const onNavigateFile = vi.fn(() => true)
    mount({ canNavigateFile: true, onNavigateFile })
    // Pure deletion collapses to (anchor - 1, 0); the revealed anchor is still line 2.
    const diffEditor = createFakeEditor([deletion(2)])
    diffEditor.setPosition(1)
    act(() => registration?.registerDiffEditor(diffEditor))

    act(() => captured?.goToNextDiff())

    expect(diffEditor.goToDiff).toHaveBeenCalledWith('next')
    expect(onNavigateFile).not.toHaveBeenCalled()
  })

  it('hands next navigation to the file callback after the last hunk, also at the modified file end', () => {
    const onNavigateFile = vi.fn(() => true)
    mount({ canNavigateFile: true, onNavigateFile })
    const diffEditor = createFakeEditor([change(10), deletion(20)])
    diffEditor.setPosition(1)
    act(() => registration?.registerDiffEditor(diffEditor))

    diffEditor.setPosition(30)
    act(() => captured?.goToNextDiff())
    expect(onNavigateFile).toHaveBeenCalledWith('next')
    expect(diffEditor.goToDiff).not.toHaveBeenCalled()

    diffEditor.setLineCount(30)
    diffEditor.setPosition(30)
    act(() => captured?.goToNextDiff())
    expect(onNavigateFile).toHaveBeenCalledTimes(2)
  })

  it('hands previous navigation to the file callback before the first hunk', () => {
    const onNavigateFile = vi.fn(() => true)
    mount({ canNavigateFile: true, onNavigateFile })
    const diffEditor = createFakeEditor([change(10)])
    diffEditor.setPosition(1)
    act(() => registration?.registerDiffEditor(diffEditor))

    act(() => captured?.goToPreviousDiff())

    expect(onNavigateFile).toHaveBeenCalledWith('previous')
    expect(diffEditor.goToDiff).not.toHaveBeenCalled()
  })

  it('hands off immediately when the registered diff has no text hunks', () => {
    const onNavigateFile = vi.fn(() => true)
    mount({ canNavigateFile: true, onNavigateFile })
    const diffEditor = createFakeEditor([])
    act(() => registration?.registerDiffEditor(diffEditor))

    expect(captured?.changeCount).toBe(0)
    expect(captured?.canNavigate).toBe(true)

    act(() => captured?.goToNextDiff())

    expect(onNavigateFile).toHaveBeenCalledWith('next')
    expect(diffEditor.goToDiff).not.toHaveBeenCalled()
  })

  it('restores the same-file wrap when the file callback cannot navigate', () => {
    const onNavigateFile = vi.fn(() => false)
    mount({ canNavigateFile: true, onNavigateFile })
    const diffEditor = createFakeEditor([change(10)])
    diffEditor.setPosition(20)
    act(() => registration?.registerDiffEditor(diffEditor))

    act(() => captured?.goToNextDiff())

    expect(onNavigateFile).toHaveBeenCalledWith('next')
    expect(diffEditor.goToDiff).toHaveBeenCalledWith('next')
  })

  it('reveals pending next navigation after the replacement editor computes its diff', () => {
    const onNavigateFile = vi.fn(() => true)
    mount({ canNavigateFile: true, onNavigateFile })
    const oldEditor = createFakeEditor([change(10)])
    oldEditor.setPosition(20)
    act(() => registration?.registerDiffEditor(oldEditor))
    act(() => captured?.goToNextDiff())

    const newEditor = createFakeEditor([])
    act(() => registration?.registerDiffEditor(newEditor))
    expect(newEditor.goToDiff).not.toHaveBeenCalled()

    act(() => {
      newEditor.setLineChanges([change(5), change(15)])
      newEditor.fireUpdate()
    })

    expect(newEditor.goToDiff).toHaveBeenCalledOnce()
    expect(newEditor.goToDiff).toHaveBeenCalledWith('next')
    act(() => newEditor.fireUpdate())
    expect(newEditor.goToDiff).toHaveBeenCalledOnce()
  })

  it('reveals pending navigation when the replacement editor is already computed at registration', () => {
    const onNavigateFile = vi.fn(() => true)
    mount({ canNavigateFile: true, onNavigateFile })
    const oldEditor = createFakeEditor([change(10)])
    oldEditor.setPosition(20)
    act(() => registration?.registerDiffEditor(oldEditor))
    act(() => captured?.goToNextDiff())

    const newEditor = createFakeEditor([change(5), change(15)])
    act(() => registration?.registerDiffEditor(newEditor))

    expect(newEditor.goToDiff).toHaveBeenCalledOnce()
    expect(newEditor.goToDiff).toHaveBeenCalledWith('next')
  })

  it('drops the pending reveal once the pane reports another file, so a later editor never claims it', () => {
    const onNavigateFile = vi.fn(() => true)
    mount({ canNavigateFile: true, onNavigateFile })
    const oldEditor = createFakeEditor([change(10)])
    oldEditor.setPosition(20)
    act(() => registration?.registerDiffEditor(oldEditor))
    act(() => captured?.goToNextDiff())
    expect(onNavigateFile).toHaveBeenCalledOnce()

    // The hop target mounts no diff editor (binary); the pane moves to an unrelated file instead.
    rerender({ canNavigateFile: true, onNavigateFile, arrivalReveal: null })
    const unrelatedEditor = createFakeEditor([change(7)])
    act(() => registration?.registerDiffEditor(unrelatedEditor))
    act(() => unrelatedEditor.fireUpdate())

    expect(unrelatedEditor.goToDiff).not.toHaveBeenCalled()
  })

  it('clears pending reveal for a computed empty diff', () => {
    const onNavigateFile = vi.fn(() => true)
    mount({ canNavigateFile: true, onNavigateFile })
    const oldEditor = createFakeEditor([])
    act(() => registration?.registerDiffEditor(oldEditor))
    act(() => captured?.goToNextDiff())

    const newEditor = createFakeEditor([])
    act(() => registration?.registerDiffEditor(newEditor))
    act(() => newEditor.fireUpdate())
    act(() => {
      newEditor.setLineChanges([change(1)])
      newEditor.fireUpdate()
    })

    expect(newEditor.goToDiff).not.toHaveBeenCalled()
  })
})
