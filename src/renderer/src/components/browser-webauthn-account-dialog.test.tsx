// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { BrowserWebAuthnAccountRequest } from '../../../shared/browser-webauthn-account'

const { respondMock, setBlockingSurfaceMock } = vi.hoisted(() => ({
  respondMock: vi.fn(),
  setBlockingSurfaceMock: vi.fn()
}))

vi.mock('@/i18n/i18n', () => ({ translate: (_key: string, fallback: string) => fallback }))
vi.mock('@/store', () => ({
  useAppStore: (selector: (state: unknown) => unknown) =>
    selector({ setContextualToursBlockingSurfaceVisible: setBlockingSurfaceMock })
}))

import { BrowserWebAuthnAccountDialog } from './browser-webauthn-account-dialog'

describe('BrowserWebAuthnAccountDialog', () => {
  let requestListener!: (request: BrowserWebAuthnAccountRequest) => void
  let closedListener!: (event: { requestId: string }) => void

  afterEach(cleanup)

  beforeEach(() => {
    respondMock.mockReset().mockResolvedValue(true)
    setBlockingSurfaceMock.mockReset()
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        browser: {
          onWebAuthnAccountRequest: vi.fn((callback) => {
            requestListener = callback
            return vi.fn()
          }),
          onWebAuthnAccountRequestClosed: vi.fn((callback) => {
            closedListener = callback
            return vi.fn()
          }),
          respondWebAuthnAccount: respondMock
        }
      }
    })
  })

  function showRequest(): void {
    act(() => {
      requestListener({
        requestId: 'request-1',
        browserPageId: 'page-1',
        relyingPartyId: 'accounts.example.com',
        accounts: [
          { credentialId: 'personal-id', displayName: 'Personal', name: 'me@example.com' },
          { credentialId: 'work-id', displayName: 'Work', name: 'me@work.example' }
        ]
      })
    })
  }

  it('returns the selected credential without displaying opaque credential IDs', async () => {
    render(<BrowserWebAuthnAccountDialog />)
    showRequest()

    expect(screen.getByText('accounts.example.com')).toBeInTheDocument()
    expect(screen.queryByText('work-id')).not.toBeInTheDocument()
    await waitFor(() => expect(screen.getByRole('button', { name: /Personal/ })).toHaveFocus())
    fireEvent.click(screen.getByRole('button', { name: /Work/ }))

    expect(respondMock).toHaveBeenCalledWith({
      requestId: 'request-1',
      credentialId: 'work-id'
    })
  })

  it('returns null only when the user cancels', () => {
    render(<BrowserWebAuthnAccountDialog />)
    showRequest()

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))

    expect(respondMock).toHaveBeenCalledWith({
      requestId: 'request-1',
      credentialId: null
    })
  })

  it('closes a timed-out prompt when main dispatches teardown', () => {
    render(<BrowserWebAuthnAccountDialog />)
    showRequest()

    act(() => closedListener({ requestId: 'request-1' }))

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })
})
