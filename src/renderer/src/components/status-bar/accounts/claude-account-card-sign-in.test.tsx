// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { ProviderRateLimits } from '../../../../../shared/agent-usage/rate-limits/rate-limit-types'
import { claudeAccountCardSignIn } from './claude-account-card-sign-in'

vi.mock('../usage/InlineProviderUsage', () => ({
  InlineUsageSignInAction: (props: {
    isSigningIn: boolean
    disabled: boolean
    onSignIn: () => void
  }) => (
    <button type="button" disabled={props.disabled} onClick={props.onSignIn}>
      {props.isSigningIn ? 'Signing in…' : 'Sign in'}
    </button>
  )
}))
afterEach(cleanup)

const signedOut: ProviderRateLimits = {
  provider: 'claude',
  status: 'error',
  session: null,
  weekly: null,
  error: 'missing',
  updatedAt: 1,
  usageMetadata: { failureKind: 'missing-credentials' }
}
const target = { id: 'alex', label: 'alex@example.com' }

it('shows one Signed out row whose button signs in the card account', () => {
  const onSignIn = vi.fn()
  render(
    <>
      {claudeAccountCardSignIn({
        claude: signedOut,
        target,
        signingInId: null,
        disabled: false,
        onSignIn
      })}
    </>
  )
  expect(screen.getByRole('status').textContent).toContain('Signed out')
  fireEvent.click(screen.getByRole('button', { name: 'Sign in' }))
  expect(onSignIn).toHaveBeenCalledWith('alex')
})

it('holds the button busy while that account signs in', () => {
  render(
    <>
      {claudeAccountCardSignIn({
        claude: signedOut,
        target,
        signingInId: 'alex',
        disabled: false,
        onSignIn: () => {}
      })}
    </>
  )
  expect(screen.getByRole('button', { name: 'Signing in…' }).hasAttribute('disabled')).toBe(true)
})

it('shows nothing once usage reads, or when the card shows no account', () => {
  const ok = { ...signedOut, status: 'ok' as const, error: null, usageMetadata: undefined }
  const args = { signingInId: null, disabled: false, onSignIn: () => {} }
  expect(claudeAccountCardSignIn({ ...args, claude: ok, target })).toBeUndefined()
  expect(claudeAccountCardSignIn({ ...args, claude: signedOut, target: undefined })).toBeUndefined()
})
