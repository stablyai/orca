// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { KeybindingOverrides } from '../../../../shared/keybindings'
import type { DiffSectionItemProps } from './diff-section-item-props'
import { DiffSectionItem } from './DiffSectionItem'

const shortcutState = vi.hoisted(
  (): { keybindings: KeybindingOverrides; editorFontZoomLevel: number } => ({
    keybindings: {},
    editorFontZoomLevel: 0
  })
)

vi.mock('@/lib/shortcut-platform', () => ({ getShortcutPlatform: () => 'darwin' }))
vi.mock('@/store', () => ({
  useAppStore: Object.assign(
    (selector: (state: typeof shortcutState) => unknown) => selector(shortcutState),
    {
      getState: () => shortcutState
    }
  )
}))
vi.mock('../diff-comments/useDiffCommentDecorator', () => ({ useDiffCommentDecorator: vi.fn() }))
vi.mock('./diff-editor-line-number-options', () => ({
  applyDiffEditorLineNumberOptions: () => ({ dispose: vi.fn() })
}))
vi.mock('./use-diff-section-model-lifecycle', () => ({
  useDiffSectionModelLifecycle: () => ({
    disposeDiffModels: vi.fn(),
    setSectionRootNode: vi.fn()
  })
}))
vi.mock('./DiffSectionHeader', () => ({ DiffSectionHeader: () => null }))
vi.mock('./DiffSectionBody', () => ({
  DiffSectionBody: ({ onMount }: { onMount: MountEditor }) => {
    mountEditor = onMount
    return null
  }
}))

type MountEditor = (editor: ReturnType<typeof createDiffEditor>['editor']) => void
let mountEditor: MountEditor | undefined
let root: Root | undefined
let disposeEditor: (() => void) | undefined

function createPane() {
  const container = document.createElement('div')
  const input = document.createElement('textarea')
  const runAction = vi.fn()
  const onDownstreamKeyDown = vi.fn()
  container.appendChild(input)
  input.addEventListener('keydown', onDownstreamKeyDown)
  return {
    container,
    input,
    runAction,
    onDownstreamKeyDown,
    editor: {
      getContainerDomNode: () => container,
      getAction: (id: string) => ({ run: () => runAction(id) })
    }
  }
}

function createDiffEditor() {
  const container = document.createElement('div')
  const original = createPane()
  const modified = createPane()
  const disposeListeners = new Set<() => void>()
  const modifiedEditor = {
    ...modified.editor,
    onDidDispose: (listener: () => void) => {
      disposeListeners.add(listener)
      return { dispose: () => disposeListeners.delete(listener) }
    },
    onDidContentSizeChange: () => ({ dispose: vi.fn() }),
    onDidChangeModelContent: () => ({ dispose: vi.fn() })
  }
  container.append(original.container, modified.container)
  document.body.appendChild(container)
  return {
    original,
    modified,
    editor: {
      getContainerDomNode: () => container,
      getOriginalEditor: () => original.editor,
      getModifiedEditor: () => modifiedEditor,
      getLineChanges: () => null,
      onDidUpdateDiff: () => ({ dispose: vi.fn() }),
      goToDiff: vi.fn()
    },
    dispose: () => {
      for (const listener of disposeListeners) {
        listener()
      }
      disposeListeners.clear()
    }
  }
}

function mountSection(area: 'staged' | 'unstaged') {
  const container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  const props: DiffSectionItemProps = {
    section: {
      key: 'section',
      path: 'file.ts',
      status: 'modified',
      area,
      originalContent: 'before',
      modifiedContent: 'after',
      collapsed: false,
      loading: false,
      dirty: false,
      diffResult: null,
      largeDiffRenderLimit: null
    },
    index: 0,
    isBranchMode: false,
    sideBySide: true,
    isDark: true,
    settings: null,
    sectionHeight: undefined,
    loadSection: vi.fn(),
    retrySection: vi.fn(),
    toggleSection: vi.fn(),
    openSection: vi.fn(),
    openSectionTitle: 'Open file',
    setSectionHeights: vi.fn(),
    setSections: vi.fn(),
    modifiedEditorsRef: { current: new Map() },
    handleSectionSaveRef: { current: vi.fn(async () => {}) }
  }
  act(() => root?.render(<DiffSectionItem {...props} />))
  const onMount = mountEditor
  if (!onMount) {
    throw new Error('DiffSectionBody did not receive an onMount handler')
  }
  const fixture = createDiffEditor()
  disposeEditor = fixture.dispose
  act(() => onMount(fixture.editor))
  return fixture
}

function pressF1(target: HTMLElement, repeat = false): KeyboardEvent {
  const event = new KeyboardEvent('keydown', {
    key: 'F1',
    code: 'F1',
    bubbles: true,
    cancelable: true,
    repeat
  })
  target.dispatchEvent(event)
  return event
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  shortcutState.keybindings = {}
})

afterEach(() => {
  act(() => {
    disposeEditor?.()
    root?.unmount()
  })
  disposeEditor = undefined
  root = undefined
  mountEditor = undefined
  document.body.replaceChildren()
  vi.unstubAllGlobals()
})

describe.each(['staged', 'unstaged'] as const)('DiffSectionItem shortcuts (%s)', (area) => {
  describe.each([
    { palette: 'default', overrides: {} },
    { palette: 'disabled', overrides: { 'editor.commandPalette': [] } },
    { palette: 'remapped', overrides: { 'editor.commandPalette': ['Mod+Shift+P'] } }
  ])('with the palette $palette', ({ overrides }) => {
    it.each([
      { action: 'editor.nextChange', direction: 'next' },
      { action: 'editor.previousChange', direction: 'previous' }
    ] as const)('routes custom F1 to $action in both panes', ({ action, direction }) => {
      shortcutState.keybindings = { ...overrides, [action]: ['F1'] }
      const fixture = mountSection(area)

      for (const pane of [fixture.original, fixture.modified]) {
        expect(pressF1(pane.input).defaultPrevented).toBe(true)
        expect(pressF1(pane.input, true).defaultPrevented).toBe(true)
        expect(pane.runAction).not.toHaveBeenCalled()
        expect(pane.onDownstreamKeyDown).not.toHaveBeenCalled()
      }
      expect(fixture.editor.goToDiff.mock.calls).toEqual([[direction], [direction]])
    })
  })

  it('keeps the default F1 command palette in both panes', () => {
    const fixture = mountSection(area)

    for (const pane of [fixture.original, fixture.modified]) {
      expect(pressF1(pane.input).defaultPrevented).toBe(true)
      expect(pane.runAction).toHaveBeenCalledExactlyOnceWith('editor.action.quickCommand')
      expect(pane.onDownstreamKeyDown).not.toHaveBeenCalled()
    }
    expect(fixture.editor.goToDiff).not.toHaveBeenCalled()
  })

  it('removes the navigation shortcut when the section editor is disposed', () => {
    shortcutState.keybindings = { 'editor.nextChange': ['F1'] }
    const fixture = mountSection(area)

    act(() => fixture.dispose())

    for (const pane of [fixture.original, fixture.modified]) {
      expect(pressF1(pane.input).defaultPrevented).toBe(false)
      expect(pane.runAction).not.toHaveBeenCalled()
      expect(pane.onDownstreamKeyDown).toHaveBeenCalledOnce()
    }
    expect(fixture.editor.goToDiff).not.toHaveBeenCalled()
  })
})
