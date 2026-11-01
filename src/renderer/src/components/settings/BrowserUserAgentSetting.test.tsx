// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LOCAL_EXECUTION_HOST_ID, type ExecutionHostId } from '../../../../shared/execution-host'
import { TooltipProvider } from '../ui/tooltip'
import { BrowserUserAgentSetting } from './BrowserUserAgentSetting'

const identityGet = vi.fn()
const identitySet = vi.fn()

function renderFor(hostId: ExecutionHostId): void {
  render(
    <TooltipProvider>
      <BrowserUserAgentSetting hostId={hostId} />
    </TooltipProvider>
  )
}

function statusFor(
  mode: 'clean' | 'native',
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    identity: {
      state: 'valid',
      appliedMode: mode,
      configuredMode: mode,
      explicitSelection: true,
      migrationNoticePending: false,
      restartRequired: false,
      ...overrides
    },
    migrationNotice: null
  }
}

describe('BrowserUserAgentSetting', () => {
  beforeEach(() => {
    identityGet.mockReset()
    identitySet.mockReset()
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { browser: { identityGet, identitySet } }
    })
  })

  afterEach(cleanup)

  it('never substitutes the local identity while Remote Settings is focused', () => {
    identityGet.mockResolvedValue(statusFor('native'))

    renderFor('runtime:remote-host')

    expect(identityGet).not.toHaveBeenCalled()
    expect(screen.getByText(/manage browser identity on the remote host/i)).toBeTruthy()
    expect(screen.queryByRole('radiogroup')).toBeNull()
  })

  it('commits the chosen mode and reports that a restart is required', async () => {
    identityGet.mockResolvedValue(statusFor('clean'))
    identitySet.mockResolvedValue({
      ok: true,
      identity: {
        state: 'valid',
        appliedMode: 'clean',
        configuredMode: 'native',
        explicitSelection: true,
        migrationNoticePending: false,
        restartRequired: true
      }
    })

    renderFor(LOCAL_EXECUTION_HOST_ID)
    fireEvent.click(await screen.findByRole('radio', { name: 'Native' }))

    await waitFor(() => expect(screen.getByText(/restart required/i)).toBeTruthy())
    expect(identitySet).toHaveBeenCalledWith('native')
    expect(screen.getByRole('radio', { name: 'Native' }).getAttribute('aria-checked')).toBe('true')
  })

  it('surfaces a refused write instead of showing the mode as changed', async () => {
    identityGet.mockResolvedValue(statusFor('clean'))
    identitySet.mockResolvedValue({
      ok: false,
      error: { code: 'browser_identity_reset_required', message: 'Identity data is corrupt' },
      identity: statusFor('clean').identity
    })

    renderFor(LOCAL_EXECUTION_HOST_ID)
    fireEvent.click(await screen.findByRole('radio', { name: 'Native' }))

    await waitFor(() => expect(screen.getByText('Identity data is corrupt')).toBeTruthy())
    expect(screen.getByRole('radio', { name: 'Cleaned' }).getAttribute('aria-checked')).toBe('true')
  })
})
