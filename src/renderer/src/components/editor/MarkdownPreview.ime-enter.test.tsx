// @vitest-environment happy-dom

import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MarkdownAnnotationComposer } from './MarkdownPreview'

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

function renderComposer(onSubmit: (body: string) => Promise<boolean>): HTMLTextAreaElement {
  const view = render(
    <MarkdownAnnotationComposer lineNumber={1} onCancel={() => {}} onSubmit={onSubmit} />
  )
  const input = view.getByRole('textbox') as HTMLTextAreaElement
  fireEvent.change(input, { target: { value: '테스' } })
  return input
}

function dispatchRecordedGesture(input: HTMLTextAreaElement): boolean {
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

afterEach(cleanup)

describe('MarkdownAnnotationComposer IME Enter ownership', () => {
  it('does not publish on the recorded Korean Enter redispatch', () => {
    const onSubmit = vi.fn(async () => true)
    const input = renderComposer(onSubmit)

    expect(dispatchRecordedGesture(input)).toBe(true)
    expect(onSubmit).not.toHaveBeenCalled()
  })

  it('publishes exactly once on ordinary Enter', () => {
    const onSubmit = vi.fn(async () => true)
    const input = renderComposer(onSubmit)

    dispatchKey(input, 'keydown', {
      key: 'Enter',
      code: 'Enter',
      keyCode: 13,
      isComposing: false
    })

    expect(onSubmit).toHaveBeenCalledOnce()
    expect(onSubmit).toHaveBeenCalledWith('테스')
  })
})
