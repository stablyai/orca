// @vitest-environment happy-dom

import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DiffCommentCard } from './DiffCommentCard'

function dispatchKey(
  input: HTMLTextAreaElement,
  type: 'keydown' | 'keyup',
  init: KeyboardEventInit
): boolean {
  const event = new KeyboardEvent(type, { bubbles: true, cancelable: true, ...init })
  Object.defineProperty(event, 'keyCode', { value: init.keyCode })
  act(() => input.dispatchEvent(event))
  return event.defaultPrevented
}

function renderEditor(onSubmitEdit: (body: string) => Promise<boolean>): HTMLTextAreaElement {
  const view = render(
    <DiffCommentCard lineNumber={1} body="original" onSubmitEdit={onSubmitEdit} />
  )
  fireEvent.click(view.getByRole('button', { name: 'Edit note' }))
  const input = view.getByRole('textbox') as HTMLTextAreaElement
  fireEvent.change(input, { target: { value: '테스' } })
  return input
}

afterEach(cleanup)

describe('DiffCommentCard IME Enter ownership', () => {
  it('does not publish on the recorded Korean Enter redispatch', () => {
    const onSubmitEdit = vi.fn(async () => true)
    const input = renderEditor(onSubmitEdit)

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

    expect(prevented).toBe(true)
    expect(onSubmitEdit).not.toHaveBeenCalled()
  })

  it('publishes exactly once on ordinary Enter', () => {
    const onSubmitEdit = vi.fn(async () => true)
    const input = renderEditor(onSubmitEdit)

    dispatchKey(input, 'keydown', {
      key: 'Enter',
      code: 'Enter',
      keyCode: 13,
      isComposing: false
    })

    expect(onSubmitEdit).toHaveBeenCalledOnce()
    expect(onSubmitEdit).toHaveBeenCalledWith('테스')
  })
})
