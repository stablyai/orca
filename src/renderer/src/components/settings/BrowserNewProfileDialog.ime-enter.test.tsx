// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  dispatchOrdinaryImplicitSubmit,
  dispatchRecordedImeImplicitSubmit
} from '../ime-enter-guarded-form.test-events'

const store = vi.hoisted(() => ({
  createBrowserSessionProfile: vi.fn(async () => ({ id: 'profile-1', label: '한국 프로필' }))
}))

vi.mock('../../store', () => ({
  useAppStore: {
    getState: () => ({ createBrowserSessionProfile: store.createBrowserSessionProfile })
  }
}))

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() }
}))

import { BrowserNewProfileDialog } from './BrowserNewProfileDialog'

function renderDialog(): HTMLInputElement {
  render(<BrowserNewProfileDialog open onOpenChange={() => {}} />)
  const input = screen.getByPlaceholderText('Profile name') as HTMLInputElement
  fireEvent.change(input, { target: { value: '한국 프로필' } })
  return input
}

afterEach(() => {
  cleanup()
  store.createBrowserSessionProfile.mockClear()
})

describe('BrowserNewProfileDialog IME implicit submit', () => {
  it('does not create a browser profile on the recorded Korean Enter redispatch', () => {
    const input = renderDialog()

    expect(dispatchRecordedImeImplicitSubmit(input)).toBe(true)
    expect(store.createBrowserSessionProfile).not.toHaveBeenCalled()
  })

  it('creates a browser profile exactly once on an ordinary Enter', () => {
    const input = renderDialog()

    expect(dispatchOrdinaryImplicitSubmit(input)).toBe(false)
    expect(store.createBrowserSessionProfile).toHaveBeenCalledOnce()
    expect(store.createBrowserSessionProfile).toHaveBeenCalledWith(
      'isolated',
      '한국 프로필',
      undefined
    )
  })
})
