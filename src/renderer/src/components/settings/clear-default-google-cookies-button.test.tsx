/**
 * @vitest-environment happy-dom
 */
import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'

const { confirm, clearDefaultGoogleCookies, successToast, errorToast } = vi.hoisted(() => ({
  confirm: vi.fn(),
  clearDefaultGoogleCookies: vi.fn(),
  successToast: vi.fn(),
  errorToast: vi.fn()
}))

vi.mock('@/components/confirmation-dialog-context', () => ({
  useConfirmationDialog: () => confirm
}))

vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => ({ clearDefaultGoogleCookies })
  }
}))

vi.mock('sonner', () => ({
  toast: { success: successToast, error: errorToast }
}))

import { ClearDefaultGoogleCookiesButton } from './ClearDefaultGoogleCookiesButton'

describe('ClearDefaultGoogleCookiesButton', () => {
  afterEach(() => {
    cleanup()
    confirm.mockReset()
    clearDefaultGoogleCookies.mockReset()
    successToast.mockReset()
    errorToast.mockReset()
  })

  it('stays enabled after a successful clear and can run again', async () => {
    confirm.mockResolvedValue(true)
    clearDefaultGoogleCookies.mockResolvedValue(true)
    render(<ClearDefaultGoogleCookiesButton />)

    const button = screen.getByRole('button', { name: 'Clear Google cookies' })
    expect(button).toBeEnabled()

    await userEvent.click(button)
    await userEvent.click(button)

    expect(clearDefaultGoogleCookies).toHaveBeenCalledTimes(2)
    expect(screen.getByRole('button', { name: 'Clear Google cookies' })).toBeEnabled()
  })

  it('does not clear when the confirmation is dismissed', async () => {
    confirm.mockResolvedValue(false)
    render(<ClearDefaultGoogleCookiesButton />)

    await userEvent.click(screen.getByRole('button', { name: 'Clear Google cookies' }))

    expect(clearDefaultGoogleCookies).not.toHaveBeenCalled()
  })
})
