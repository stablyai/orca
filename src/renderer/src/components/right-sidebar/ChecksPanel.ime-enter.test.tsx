// @vitest-environment happy-dom

import { createRef } from 'react'
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ChecksPanelReviewTitleInput } from './ChecksPanel'

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

function renderInput(onSubmit: () => void): HTMLInputElement {
  const inputRef = createRef<HTMLInputElement>()
  render(
    <ChecksPanelReviewTitleInput
      inputRef={inputRef}
      value="테스"
      onChange={() => {}}
      onSubmit={onSubmit}
      onCancel={() => {}}
      disabled={false}
    />
  )
  if (!inputRef.current) {
    throw new Error('missing review title input')
  }
  return inputRef.current
}

afterEach(cleanup)

describe('ChecksPanelReviewTitleInput IME Enter ownership', () => {
  it('does not update the review title on the recorded Korean Enter redispatch', () => {
    const onSubmit = vi.fn()
    const input = renderInput(onSubmit)

    expect(dispatchRecordedGesture(input)).toBe(true)
    expect(onSubmit).not.toHaveBeenCalled()
  })

  it('updates the review title exactly once on an ordinary Enter', () => {
    const onSubmit = vi.fn()
    const input = renderInput(onSubmit)

    dispatchKey(input, 'keydown', {
      key: 'Enter',
      code: 'Enter',
      keyCode: 13,
      isComposing: false
    })

    expect(onSubmit).toHaveBeenCalledOnce()
  })
})
