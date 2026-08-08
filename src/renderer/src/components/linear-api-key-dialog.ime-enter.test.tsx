// @vitest-environment happy-dom

import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { LinearApiKeyDialog } from './linear-api-key-dialog'

function dispatchKey(el: HTMLElement, init: KeyboardEventInit): boolean {
  const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init })
  Object.defineProperty(event, 'keyCode', { value: init.keyCode })
  act(() => el.dispatchEvent(event))
  return event.defaultPrevented
}

function renderWithDraft(): HTMLInputElement {
  const view = render(<LinearApiKeyDialog open onOpenChange={vi.fn()} />)
  const input = view.getByPlaceholderText('lin_api_...') as HTMLInputElement
  fireEvent.change(input, { target: { value: 'lin_api_abc' } })
  return input
}

afterEach(cleanup)

// Why: the submit handler lives on DialogContent, so it only ever sees the input's
// bubbled keydown — these lock in that the guard still reads the IME marking there.
describe('LinearApiKeyDialog IME Enter guard on bubbled keydown', () => {
  it('ignores a marked confirm keydown raised at the input', () => {
    const input = renderWithDraft()

    expect(dispatchKey(input, { key: 'Process', keyCode: 229, isComposing: true })).toBe(false)
  })

  it('still handles an ordinary Enter raised at the input', () => {
    const input = renderWithDraft()

    expect(dispatchKey(input, { key: 'Enter', keyCode: 13, isComposing: false })).toBe(true)
  })
})
