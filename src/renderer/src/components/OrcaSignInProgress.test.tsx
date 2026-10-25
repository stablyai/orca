// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'

import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import type { OrcaCloudSignInProgress } from '../../../shared/orca-profiles'
import { OrcaSignInButton, OrcaSignInWaitNotice } from './OrcaSignInProgress'

type SignInState = {
  orcaProfileSignInProgress: OrcaCloudSignInProgress | null
  connectCurrentOrcaProfile: Mock
}

const mocks = vi.hoisted((): { state: SignInState; toastError: Mock; toastSuccess: Mock } => ({
  state: { orcaProfileSignInProgress: null, connectCurrentOrcaProfile: vi.fn() },
  toastError: vi.fn(),
  toastSuccess: vi.fn()
}))

vi.mock('../store', () => ({
  useAppStore: (selector: (state: SignInState) => unknown) => selector(mocks.state)
}))

vi.mock('sonner', () => ({
  toast: { error: mocks.toastError, success: mocks.toastSuccess }
}))

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string) => fallback
}))

const LINK = 'https://login.example/authorize?state=abc'

describe('Orca sign-in progress', () => {
  const writeClipboardText = vi.fn()
  const cancelSignIn = vi.fn()

  beforeEach(() => {
    mocks.state.orcaProfileSignInProgress = null
    mocks.state.connectCurrentOrcaProfile.mockReset()
    mocks.toastError.mockReset()
    mocks.toastSuccess.mockReset()
    writeClipboardText.mockReset().mockResolvedValue(undefined)
    cancelSignIn.mockReset().mockResolvedValue(undefined)
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { ui: { writeClipboardText }, orcaProfiles: { cancelSignIn } }
    })
  })

  afterEach(() => cleanup())

  it('starts a sign-in from the button', async () => {
    render(<OrcaSignInButton>Sign in to Orca</OrcaSignInButton>)

    await userEvent.setup().click(screen.getByRole('button', { name: 'Sign in to Orca' }))

    expect(mocks.state.connectCurrentOrcaProfile).toHaveBeenCalledOnce()
  })

  it('greys the button out as Signing in… while a sign-in is in flight', () => {
    mocks.state.orcaProfileSignInProgress = { link: null }
    render(<OrcaSignInButton>Sign in to Orca</OrcaSignInButton>)

    expect(screen.getByRole('button', { name: 'Signing in…' })).toBeDisabled()
  })

  it('shows the waiting line only while the browser has not answered', () => {
    mocks.state.orcaProfileSignInProgress = { link: null }
    const { container } = render(<OrcaSignInWaitNotice />)
    expect(container).toBeEmptyDOMElement()
  })

  it('copies the waiting link', async () => {
    mocks.state.orcaProfileSignInProgress = { link: LINK }
    render(<OrcaSignInWaitNotice />)
    expect(screen.getByRole('status')).toHaveTextContent('Waiting for sign-in in your browser')

    await userEvent.setup().click(screen.getByRole('button', { name: 'Copy sign-in link' }))

    expect(writeClipboardText).toHaveBeenCalledWith(LINK)
    expect(mocks.toastSuccess).toHaveBeenCalledWith('Sign-in link copied')
  })

  it('reports a failed clipboard write', async () => {
    mocks.state.orcaProfileSignInProgress = { link: LINK }
    writeClipboardText.mockRejectedValue(new Error('denied'))
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    render(<OrcaSignInWaitNotice />)

    await userEvent.setup().click(screen.getByRole('button', { name: 'Copy sign-in link' }))

    expect(mocks.toastError).toHaveBeenCalledWith('Could not copy the link.')
  })

  it('cancels the browser wait', async () => {
    mocks.state.orcaProfileSignInProgress = { link: LINK }
    render(<OrcaSignInWaitNotice />)

    await userEvent.setup().click(screen.getByRole('button', { name: 'Cancel' }))

    expect(cancelSignIn).toHaveBeenCalledOnce()
  })
})
