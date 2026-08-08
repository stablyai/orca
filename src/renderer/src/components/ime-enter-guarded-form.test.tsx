// @vitest-environment happy-dom

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { dispatchOrdinaryImplicitSubmit } from './ime-enter-guarded-form.test-events'
import { ImeEnterGuardedForm } from './ime-enter-guarded-form'

function dispatchKey(input: HTMLInputElement, init: KeyboardEventInit): boolean {
  const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init })
  Object.defineProperty(event, 'keyCode', { value: init.keyCode })
  act(() => input.dispatchEvent(event))
  return event.defaultPrevented
}

afterEach(cleanup)

describe('form-level Enter default prevention', () => {
  it('allows browser implicit submission without a bubbled veto', async () => {
    const onSubmit = vi.fn((event: React.FormEvent) => event.preventDefault())
    const user = userEvent.setup()
    render(
      <form onSubmit={onSubmit}>
        <input aria-label="unguarded" />
      </form>
    )

    await user.click(screen.getByLabelText('unguarded'))
    await user.keyboard('{Enter}')

    expect(onSubmit).toHaveBeenCalledOnce()
  })

  it('vetoes browser implicit submission from the bubbled form keydown', async () => {
    const onSubmit = vi.fn((event: React.FormEvent) => event.preventDefault())
    let bubbledCurrentTarget: EventTarget | null = null
    const onKeyDown = vi.fn((event: React.KeyboardEvent) => {
      bubbledCurrentTarget = event.currentTarget
      event.preventDefault()
    })
    const user = userEvent.setup()
    render(
      <form onKeyDown={onKeyDown} onSubmit={onSubmit}>
        <input aria-label="guarded" />
      </form>
    )

    await user.click(screen.getByLabelText('guarded'))
    await user.keyboard('{Enter}')

    expect(onKeyDown).toHaveBeenCalledOnce()
    expect(bubbledCurrentTarget).toBeInstanceOf(HTMLFormElement)
    expect(onSubmit).not.toHaveBeenCalled()
  })
})

describe('ImeEnterGuardedForm field ownership', () => {
  it('resets the carry when focus moves between fields', () => {
    const onSubmit = vi.fn((event: React.FormEvent) => event.preventDefault())
    render(
      <ImeEnterGuardedForm onSubmit={onSubmit}>
        <input aria-label="first" />
        <input aria-label="second" />
      </ImeEnterGuardedForm>
    )
    const first = screen.getByLabelText('first') as HTMLInputElement
    const second = screen.getByLabelText('second') as HTMLInputElement

    fireEvent.focus(first)
    fireEvent.compositionStart(first)
    expect(
      dispatchKey(first, {
        key: 'Process',
        code: 'Enter',
        keyCode: 229,
        isComposing: true
      })
    ).toBe(true)
    fireEvent.compositionEnd(first, { data: '가' })
    fireEvent.blur(first)
    fireEvent.focus(second)

    expect(dispatchOrdinaryImplicitSubmit(second)).toBe(false)
    expect(onSubmit).toHaveBeenCalledOnce()
  })
})
