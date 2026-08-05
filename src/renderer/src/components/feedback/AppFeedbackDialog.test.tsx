// @vitest-environment happy-dom

import { act } from 'react'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  submit: vi.fn(),
  toastError: vi.fn(),
  toastSuccess: vi.fn()
}))

vi.mock('sonner', () => ({
  toast: {
    error: mocks.toastError,
    success: mocks.toastSuccess,
    warning: vi.fn()
  }
}))

import { useAppStore } from '@/store'
import { AppFeedbackDialog } from './AppFeedbackDialog'

function setDialogOpen(open: boolean): void {
  act(() => {
    useAppStore.getState().setFeedbackDialogOpen(open)
  })
}

function getMessageBox(): HTMLTextAreaElement {
  return screen.getByPlaceholderText('What could we improve?') as HTMLTextAreaElement
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.submit.mockResolvedValue({ ok: true })
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      feedback: { submit: mocks.submit },
      gh: { viewer: vi.fn().mockResolvedValue({ login: 'octocat', email: null }) },
      shell: { openUrl: vi.fn() }
    }
  })
  useAppStore.setState({ feedbackDialogOpen: false })
})

afterEach(() => {
  cleanup()
  useAppStore.setState({ feedbackDialogOpen: false })
})

describe('AppFeedbackDialog', () => {
  it('keeps the typed report when the dialog is dismissed and reopened', async () => {
    const user = userEvent.setup()
    render(<AppFeedbackDialog />)
    setDialogOpen(true)

    await user.type(
      await screen.findByPlaceholderText('What could we improve?'),
      'SSH pane freezes'
    )
    await user.click(await screen.findByLabelText('Submit anonymously'))

    // Why: Escape and outside clicks are unguarded, so a reflex dismiss must not
    // destroy a long report — the dialog stays mounted while closed.
    await user.keyboard('{Escape}')
    await waitFor(() => expect(useAppStore.getState().feedbackDialogOpen).toBe(false))
    setDialogOpen(true)

    expect(getMessageBox().value).toBe('SSH pane freezes')
    expect((screen.getByLabelText('Submit anonymously') as HTMLInputElement).checked).toBe(true)
  })

  it('still reports a failed submit that the user dismissed while it was in flight', async () => {
    let rejectSubmit: ((error: Error) => void) | undefined
    mocks.submit.mockReturnValue(
      new Promise((_resolve, reject) => {
        rejectSubmit = reject
      })
    )
    const user = userEvent.setup()
    render(<AppFeedbackDialog />)
    setDialogOpen(true)

    await user.type(await screen.findByPlaceholderText('What could we improve?'), 'Crash on resize')
    await user.click(screen.getByRole('button', { name: 'Send' }))
    await waitFor(() => expect(mocks.submit).toHaveBeenCalledTimes(1))

    await user.keyboard('{Escape}')
    await waitFor(() => expect(useAppStore.getState().feedbackDialogOpen).toBe(false))
    await act(async () => {
      rejectSubmit?.(new Error('network down'))
      await Promise.resolve()
    })

    await waitFor(() => expect(mocks.toastError).toHaveBeenCalledTimes(1))
  })
})
