// @vitest-environment happy-dom

import { act, cleanup, render } from '@testing-library/react'
import { useRef } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Editor } from '@tiptap/react'
import type { AppMenuSelectionAction } from '@/lib/app-commands/app-menu-selection-actions'
import { useAppMenuSelectionActions } from '@/hooks/app-commands/useAppMenuSelectionActions'
import { useRichMarkdownAppMenuSelection } from './use-rich-markdown-app-menu-selection'

let appMenuListener: ((action: AppMenuSelectionAction) => void) | null = null
let editorState: Editor | null = null
const performNativeSelectionAction = vi.fn()

function createEditor(options?: { composing?: boolean; destroyed?: boolean }): Editor {
  return {
    isDestroyed: options?.destroyed === true,
    view: { composing: options?.composing === true },
    commands: { selectAll: vi.fn(() => true) }
  } as unknown as Editor
}

function AppMenuBoundary(): null {
  useAppMenuSelectionActions()
  return null
}

function NoteHarness(): React.JSX.Element {
  const rootRef = useRef<HTMLDivElement | null>(null)
  const editorRef = useRef<Editor | null>(editorState)
  editorRef.current = editorState
  useRichMarkdownAppMenuSelection(rootRef, editorRef)
  return (
    <>
      <div ref={rootRef}>
        <div aria-label="Markdown note" role="textbox" tabIndex={0} />
      </div>
      <button type="button">Outside note</button>
    </>
  )
}

function emitAppMenuAction(action: AppMenuSelectionAction): void {
  act(() => {
    if (!appMenuListener) {
      throw new Error('app menu listener is not registered')
    }
    appMenuListener(action)
  })
}

function renderBoundaryAndNote() {
  const boundary = render(<AppMenuBoundary />)
  const note = render(<NoteHarness />)
  return { boundary, note }
}

function selectAllMock(): ReturnType<typeof vi.fn> {
  const editor = editorState
  if (!editor) {
    throw new Error('editor is not mounted')
  }
  return editor.commands.selectAll as unknown as ReturnType<typeof vi.fn>
}

beforeEach(() => {
  appMenuListener = null
  editorState = createEditor()
  performNativeSelectionAction.mockReset()
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      ui: {
        onAppMenuSelectionAction: vi.fn((listener: typeof appMenuListener) => {
          appMenuListener = listener
          return () => {
            appMenuListener = null
          }
        }),
        performNativeSelectionAction
      }
    }
  })
})

afterEach(() => {
  cleanup()
  editorState = null
  vi.restoreAllMocks()
})

describe('rich markdown app-menu selection ownership', () => {
  it('selects only the focused markdown note through the app-menu boundary', () => {
    const { note } = renderBoundaryAndNote()
    note.getByRole('textbox', { name: 'Markdown note' }).focus()

    emitAppMenuAction('select-all')

    expect(selectAllMock()).toHaveBeenCalledOnce()
    expect(performNativeSelectionAction).not.toHaveBeenCalled()
  })

  it('preserves the window fallback when focus is outside the note', () => {
    const { note } = renderBoundaryAndNote()
    note.getByRole('button', { name: 'Outside note' }).focus()

    emitAppMenuAction('select-all')

    expect(selectAllMock()).not.toHaveBeenCalled()
    expect(performNativeSelectionAction).toHaveBeenCalledOnce()
    expect(performNativeSelectionAction).toHaveBeenCalledWith('select-all')
  })

  it('claims select-all during IME composition without selecting or falling back', () => {
    editorState = createEditor({ composing: true })
    const { note } = renderBoundaryAndNote()
    note.getByRole('textbox', { name: 'Markdown note' }).focus()

    emitAppMenuAction('select-all')

    expect(selectAllMock()).not.toHaveBeenCalled()
    expect(performNativeSelectionAction).not.toHaveBeenCalled()
  })

  it('leaves copy to the native fallback while the note is focused', () => {
    const { note } = renderBoundaryAndNote()
    note.getByRole('textbox', { name: 'Markdown note' }).focus()

    emitAppMenuAction('copy')

    expect(selectAllMock()).not.toHaveBeenCalled()
    expect(performNativeSelectionAction).toHaveBeenCalledOnce()
    expect(performNativeSelectionAction).toHaveBeenCalledWith('copy')
  })
})
