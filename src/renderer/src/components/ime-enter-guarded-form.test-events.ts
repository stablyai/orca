import { act, fireEvent } from '@testing-library/react'

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

function dispatchImplicitSubmit(input: HTMLInputElement, init: KeyboardEventInit): boolean {
  const prevented = dispatchKey(input, 'keydown', init)
  if (!prevented) {
    const form = input.closest('form')
    if (!form) {
      throw new Error('missing implicit-submit form')
    }
    act(() => form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })))
  }
  return prevented
}

export function dispatchRecordedImeImplicitSubmit(input: HTMLInputElement): boolean {
  fireEvent.compositionStart(input)
  dispatchKey(input, 'keydown', {
    key: 'Process',
    code: 'Enter',
    keyCode: 229,
    isComposing: true
  })
  fireEvent.compositionEnd(input, { data: '가' })
  const prevented = dispatchImplicitSubmit(input, {
    key: 'Enter',
    code: 'Enter',
    keyCode: 13,
    isComposing: false
  })
  dispatchKey(input, 'keyup', { key: 'Process', code: 'Enter', keyCode: 229 })
  dispatchKey(input, 'keyup', { key: 'Enter', code: 'Enter', keyCode: 13 })
  return prevented
}

export function dispatchOrdinaryImplicitSubmit(input: HTMLInputElement): boolean {
  return dispatchImplicitSubmit(input, {
    key: 'Enter',
    code: 'Enter',
    keyCode: 13,
    isComposing: false
  })
}
