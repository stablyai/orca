// @vitest-environment happy-dom

import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DiffCommentPopover } from './DiffCommentPopover'

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

function renderPopover(onSubmit: (body: string) => Promise<void>) {
  const view = render(
    <DiffCommentPopover lineNumber={1} top={0} onCancel={() => {}} onSubmit={onSubmit} />
  )
  return view.getByRole('textbox') as HTMLTextAreaElement
}

afterEach(cleanup)

describe('DiffCommentPopover IME Enter ownership', () => {
  it('does not publish on the recorded Korean Enter redispatch', () => {
    const onSubmit = vi.fn(async () => {})
    const input = renderPopover(onSubmit)
    fireEvent.change(input, { target: { value: '테스' } })

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
    expect(onSubmit).not.toHaveBeenCalled()
  })

  it('publishes exactly once on ordinary Enter', () => {
    const onSubmit = vi.fn(async () => {})
    const input = renderPopover(onSubmit)
    fireEvent.change(input, { target: { value: 'ordinary comment' } })

    dispatchKey(input, 'keydown', {
      key: 'Enter',
      code: 'Enter',
      keyCode: 13,
      isComposing: false
    })

    expect(onSubmit).toHaveBeenCalledOnce()
    expect(onSubmit).toHaveBeenCalledWith('ordinary comment')
  })
})

describe('DiffCommentPopover Shift+Enter newline', () => {
  // Regression: the carry matched any Enter/13 with no shiftKey check, so after a
  // composition the Shift+Enter NEWLINE gesture was owned and preventDefault()ed —
  // in a multi-line comment box, which is where newlines matter most.
  it('never owns Shift+Enter, during composition or on the redispatch', () => {
    const onSubmit = vi.fn(async () => {})
    const input = renderPopover(onSubmit)
    fireEvent.change(input, { target: { value: '테스' } })

    fireEvent.compositionStart(input)
    const marked = dispatchKey(input, 'keydown', {
      key: 'Enter',
      code: 'Enter',
      keyCode: 13,
      isComposing: true,
      shiftKey: true
    })
    fireEvent.compositionEnd(input, { data: '가' })
    const redispatch = dispatchKey(input, 'keydown', {
      key: 'Enter',
      code: 'Enter',
      keyCode: 13,
      isComposing: false,
      shiftKey: true
    })

    expect(marked).toBe(false)
    expect(redispatch).toBe(false)
    expect(onSubmit).not.toHaveBeenCalled()
  })
})
