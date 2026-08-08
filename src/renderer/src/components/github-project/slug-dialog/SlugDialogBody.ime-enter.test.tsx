// @vitest-environment happy-dom

import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SlugDialogTitleInput } from './SlugDialogBody'

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

function renderInput(onCommit: () => void): HTMLInputElement {
  const view = render(
    <SlugDialogTitleInput
      value="테스"
      onChange={() => {}}
      onCommit={onCommit}
      onCancel={() => {}}
    />
  )
  return view.getByRole('textbox') as HTMLInputElement
}

afterEach(cleanup)

describe('SlugDialogTitleInput IME Enter ownership', () => {
  it('does not update the issue title on the recorded Korean Enter redispatch', () => {
    const onCommit = vi.fn()
    const input = renderInput(onCommit)

    expect(dispatchRecordedGesture(input)).toBe(true)
    expect(onCommit).not.toHaveBeenCalled()
  })

  it('updates the issue title exactly once on an ordinary Enter', () => {
    const onCommit = vi.fn()
    const input = renderInput(onCommit)

    dispatchKey(input, 'keydown', {
      key: 'Enter',
      code: 'Enter',
      keyCode: 13,
      isComposing: false
    })

    expect(onCommit).toHaveBeenCalledOnce()
  })
})
