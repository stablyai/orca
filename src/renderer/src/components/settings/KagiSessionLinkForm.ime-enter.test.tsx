// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  dispatchOrdinaryImplicitSubmit,
  dispatchRecordedImeImplicitSubmit
} from '../ime-enter-guarded-form.test-events'

const store = vi.hoisted(() => ({
  setBrowserKagiSessionLink: vi.fn()
}))

vi.mock('../../store', () => ({
  useAppStore: (
    selector: (state: {
      browserKagiSessionLink: string | null
      setBrowserKagiSessionLink: typeof store.setBrowserKagiSessionLink
    }) => unknown
  ): unknown =>
    selector({
      browserKagiSessionLink: null,
      setBrowserKagiSessionLink: store.setBrowserKagiSessionLink
    })
}))

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() }
}))

import { KagiSessionLinkForm } from './KagiSessionLinkForm'

function renderForm(): HTMLInputElement {
  render(<KagiSessionLinkForm />)
  const input = screen.getByLabelText('Kagi private session link') as HTMLInputElement
  fireEvent.change(input, {
    target: { value: 'https://kagi.com/search?token=한글-token' }
  })
  return input
}

afterEach(() => {
  cleanup()
  store.setBrowserKagiSessionLink.mockClear()
})

describe('KagiSessionLinkForm IME implicit submit', () => {
  it('does not persist the secret on the recorded Korean Enter redispatch', () => {
    const input = renderForm()

    expect(dispatchRecordedImeImplicitSubmit(input)).toBe(true)
    expect(store.setBrowserKagiSessionLink).not.toHaveBeenCalled()
  })

  it('persists the secret exactly once on an ordinary Enter', () => {
    const input = renderForm()

    expect(dispatchOrdinaryImplicitSubmit(input)).toBe(false)
    expect(store.setBrowserKagiSessionLink).toHaveBeenCalledOnce()
    expect(store.setBrowserKagiSessionLink).toHaveBeenCalledWith(
      'https://kagi.com/search?token=%ED%95%9C%EA%B8%80-token'
    )
  })
})
