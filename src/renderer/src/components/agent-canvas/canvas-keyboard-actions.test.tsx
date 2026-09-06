// @vitest-environment happy-dom
import { cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { handleCanvasKeyDown } from './canvas-keyboard-actions'

afterEach(cleanup)

it('removes selected cards or edges and preserves editing and terminal input', () => {
  const actions = {
    readOnly: false,
    selectedId: 'note' as string | null,
    edgeId: 'edge',
    removeNode: vi.fn(),
    removeEdge: vi.fn(),
    clearSelection: vi.fn()
  }
  const view = render(
    <div
      data-testid="canvas"
      tabIndex={0}
      onKeyDown={(event) => handleCanvasKeyDown(event, actions)}
    >
      <textarea aria-label="Note" />
      <div className="xterm">
        <textarea className="xterm-helper-textarea" aria-label="Terminal" />
      </div>
      <div contentEditable suppressContentEditableWarning data-testid="editor">
        Draft
      </div>
      <button>Connect</button>
    </div>
  )
  for (const target of [
    view.getByLabelText('Note'),
    view.getByLabelText('Terminal'),
    view.getByTestId('editor'),
    view.getByRole('button')
  ]) {
    fireEvent.keyDown(target, { key: 'Backspace' })
    fireEvent.keyDown(target, { key: 'Delete' })
  }
  expect(actions.removeNode).not.toHaveBeenCalled()
  fireEvent.keyDown(view.getByTestId('canvas'), { key: 'Delete' })
  expect(actions.removeNode).toHaveBeenCalledWith('note')
  expect(actions.removeEdge).not.toHaveBeenCalled()
  actions.selectedId = null
  fireEvent.keyDown(view.getByTestId('canvas'), { key: 'Backspace' })
  expect(actions.removeEdge).toHaveBeenCalledWith('edge')
  actions.readOnly = true
  fireEvent.keyDown(view.getByTestId('canvas'), { key: 'Delete' })
  expect(actions.removeEdge).toHaveBeenCalledTimes(1)
})
