// @vitest-environment happy-dom

import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

const editor = vi.hoisted(() => ({
  commitPendingText: vi.fn(),
  cancelPendingText: vi.fn()
}))

vi.mock('./useMarkupEditor', async () => {
  const { createRef } = await import('react')
  return {
    useMarkupEditor: () => ({
      rootRef: createRef<HTMLDivElement>(),
      canvasRef: createRef<HTMLCanvasElement>(),
      textInputRef: createRef<HTMLInputElement>(),
      tool: 'text',
      color: '#ffffff',
      width: 2,
      fontSize: 16,
      pendingText: { x: 10, y: 20, initial: '테스' },
      shapes: [],
      canUndo: false,
      canRedo: false,
      setTool: vi.fn(),
      setColor: vi.fn(),
      setWidth: vi.fn(),
      setFontSize: vi.fn(),
      undo: vi.fn(),
      redo: vi.fn(),
      clear: vi.fn(),
      onPointerDown: vi.fn(),
      onPointerMove: vi.fn(),
      onPointerUp: vi.fn(),
      commitPendingText: editor.commitPendingText,
      cancelPendingText: editor.cancelPendingText
    })
  }
})

import { MarkupOverlay } from './MarkupOverlay'

function dispatchKey(
  input: HTMLInputElement,
  type: 'keydown' | 'keyup',
  init: KeyboardEventInit
): boolean {
  const event = new KeyboardEvent(type, { bubbles: true, cancelable: true, ...init })
  Object.defineProperty(event, 'keyCode', { value: init.keyCode })
  act(() => input.dispatchEvent(event))
  return event.defaultPrevented
}

function renderInput(): HTMLInputElement {
  const view = render(
    <MarkupOverlay
      baseImage={{ dataUrl: 'data:image/png;base64,', width: 100, height: 100 }}
      busy={false}
      onComplete={() => {}}
      onCancel={() => {}}
    />
  )
  return view.getByRole('textbox', { name: 'Annotation text' }) as HTMLInputElement
}

function dispatchRecordedGesture(input: HTMLInputElement): boolean {
  fireEvent.compositionStart(input)
  dispatchKey(input, 'keydown', {
    key: 'Process',
    code: 'Enter',
    keyCode: 229,
    isComposing: true
  })
  fireEvent.compositionEnd(input, { data: '가' })
  const prevented = dispatchKey(input, 'keydown', {
    key: 'Enter',
    code: 'Enter',
    keyCode: 13,
    isComposing: false
  })
  dispatchKey(input, 'keyup', { key: 'Process', keyCode: 229 })
  dispatchKey(input, 'keyup', { key: 'Enter', keyCode: 13 })
  return prevented
}

afterEach(() => {
  cleanup()
  editor.commitPendingText.mockClear()
  editor.cancelPendingText.mockClear()
})

describe('MarkupOverlay IME Enter ownership', () => {
  it('does not commit on the recorded Korean Enter redispatch', () => {
    const input = renderInput()

    expect(dispatchRecordedGesture(input)).toBe(true)
    expect(editor.commitPendingText).not.toHaveBeenCalled()
  })

  it('commits exactly once on ordinary Enter', () => {
    const input = renderInput()

    dispatchKey(input, 'keydown', {
      key: 'Enter',
      code: 'Enter',
      keyCode: 13,
      isComposing: false
    })

    expect(editor.commitPendingText).toHaveBeenCalledOnce()
    expect(editor.commitPendingText).toHaveBeenCalledWith('테스')
  })
})
