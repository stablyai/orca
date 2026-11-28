// @vitest-environment happy-dom

import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type {
  CursorAccountStatus,
  ProviderRateLimits
} from '../../../../../../shared/agent-usage/rate-limits/rate-limit-types'
import { CursorAccountsSection } from './CursorAccountsSection'

let cursorUsage: ProviderRateLimits | null = null

vi.mock('../../../../store/index', () => ({
  useAppStore: (select: (s: unknown) => unknown) =>
    select({ refreshRateLimits: async () => {}, rateLimits: { cursor: cursorUsage } })
}))
vi.mock('@/store/retained-views/app-state-view', () => ({
  useAppStateValue: (select: (s: { settingsSearchQuery: string }) => unknown) =>
    select({ settingsSearchQuery: '' })
}))

const signedOut: CursorAccountStatus = {
  signedIn: false,
  email: null,
  displayName: null,
  credentialSource: null,
  planType: null,
  tokenFresh: false,
  error: null
}

// What the keychain read that didn't answer left: no live session, the reason, and the flag.
const unchecked: CursorAccountStatus = {
  ...signedOut,
  checkUnavailable: true,
  error: 'Unable to read the Cursor login from the macOS Keychain'
}

const CANT_CHECK = 'Can’t check Cursor sign-in right now'
const CANT_CHECK_DETAIL = "macOS Keychain didn't answer in time. Click Refresh usage to try again."

function showStatus(status: CursorAccountStatus): void {
  Object.assign(window, { api: { cursorAccounts: { getStatus: async () => status } } })
  render(<CursorAccountsSection />)
}

afterEach(() => {
  cleanup()
  cursorUsage = null
})

// Incident replay: the macOS Keychain didn't answer in time; the login is there.
it('says it cannot check the sign-in right now when the keychain did not answer', async () => {
  showStatus(unchecked)
  const title = await screen.findByText(CANT_CHECK)
  const detail = screen.getByText(CANT_CHECK_DETAIL)
  // Muted, never an error.
  expect(detail.className).toContain('text-muted-foreground')
  expect(title.closest('.text-destructive')).toBeNull()
  expect(screen.queryByText(unchecked.error!)).toBeNull()
  // Nothing that says or implies signed out, signed in, or how to sign in.
  expect(screen.queryByText('No Cursor sign-in found on this computer')).toBeNull()
  expect(screen.queryByText(/Sign in with Cursor IDE/)).toBeNull()
  expect(screen.queryByText(/^Signed in/)).toBeNull()
})

it('keeps last known usage without a raw failure reason while it cannot check', async () => {
  cursorUsage = {
    provider: 'cursor',
    session: null,
    weekly: null,
    monthly: null,
    buckets: [
      { name: 'Included', usedPercent: 40, windowMinutes: 43_200, resetsAt: null, resetDescription: null }
    ],
    updatedAt: Date.now() - 60_000,
    error: 'Unable to read the Cursor login from the macOS Keychain',
    status: 'error'
  } as ProviderRateLimits
  showStatus(unchecked)
  expect(await screen.findByText('Last known usage — couldn’t refresh just now.')).toBeTruthy()
  expect(screen.queryByText(/the latest refresh failed/)).toBeNull()
})

it('says no sign-in was found when the keychain definitively has none', async () => {
  showStatus(signedOut)
  expect(await screen.findByText('No Cursor sign-in found on this computer')).toBeTruthy()
  expect(screen.queryByText(CANT_CHECK)).toBeNull()
})
