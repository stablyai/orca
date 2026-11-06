// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, expect, it, vi } from 'vitest'
import { AntigravityChatAuthForm } from './AntigravityChatAuthForm'
import { callAntigravityChatAuthConfig } from '@/runtime/runtime-antigravity-accounts-client'
import { observeAntigravityChatSignIn } from '@/runtime/antigravity-chat-sign-in-status'
import type { RuntimeRpcSubscriptionHandlers } from '@/runtime/runtime-rpc-subscribe'
import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'

const streams = vi.hoisted(() => ({
  handlers: new Map<string, RuntimeRpcSubscriptionHandlers>(),
  releases: [] as (() => void)[]
}))
const key = (owner: RuntimeClientTarget): string =>
  owner.kind === 'local' ? 'local' : owner.environmentId
function follow(owner: RuntimeClientTarget): void {
  streams.releases.push(observeAntigravityChatSignIn(owner))
}
vi.mock('@/runtime/structured-agent-session-host-capability', () => ({
  useStructuredAgentSessionHostCapabilityState: () => 'supported'
}))
vi.mock('@/runtime/runtime-antigravity-accounts-client', () => ({
  callAntigravityChatAuthConfig: vi.fn(),
  callAntigravityChatSignIn: vi.fn(),
  subscribeAntigravityChatSignIn: vi.fn(
    async (owner: RuntimeClientTarget, handlers: RuntimeRpcSubscriptionHandlers) => {
      streams.handlers.set(owner.kind === 'local' ? 'local' : owner.environmentId, handlers)
      handlers.onEvent({ revision: 0, auth: 'unknown', flow: null })
      return { unsubscribe: () => {} }
    }
  )
}))
afterEach(() => {
  cleanup()
  streams.releases.splice(0).forEach((release) => release())
  streams.handlers.clear()
  vi.mocked(callAntigravityChatAuthConfig).mockReset()
  vi.useRealTimers()
})

it('applies a complete Enterprise choice to the selected execution host, keeping inputs on save failure', async () => {
  const target = { kind: 'environment', environmentId: 'host-enterprise' } as const
  const personal = { method: 'oauth-personal' } as const
  vi.mocked(callAntigravityChatAuthConfig)
    .mockResolvedValueOnce(personal)
    .mockRejectedValueOnce(new Error('Could not save account settings'))
  const user = userEvent.setup()
  follow(target)
  render(<AntigravityChatAuthForm owner={target} disabled={false} />)
  await waitFor(() => expect(screen.getByRole('combobox')).toBeEnabled())
  await user.click(screen.getByRole('combobox'))
  await user.click(screen.getByRole('option', { name: 'Gemini Enterprise' }))
  await user.type(screen.getByLabelText('Google Cloud project'), 'enterprise-project')
  await user.type(screen.getByLabelText('Google Cloud location'), 'us-central1')
  await user.click(screen.getByRole('button', { name: 'Apply account settings' }))
  await screen.findByRole('alert')
  expect(callAntigravityChatAuthConfig).toHaveBeenLastCalledWith(target, {
    method: 'oauth-business',
    gcpProject: 'enterprise-project',
    gcpLocation: 'us-central1'
  })
  expect(screen.getByLabelText('Google Cloud project')).toHaveValue('enterprise-project')
  expect(screen.getByRole('button', { name: 'Apply account settings' })).toBeEnabled()
})

it('follows another client’s account change while mounted and allows Personal to be applied again', async () => {
  vi.mocked(callAntigravityChatAuthConfig)
    .mockResolvedValueOnce({ method: 'oauth-personal' })
    .mockResolvedValue({
      method: 'oauth-business',
      gcpProject: 'enterprise-project',
      gcpLocation: 'us-central1'
    })
  const user = userEvent.setup()
  const target = { kind: 'environment', environmentId: 'connected-client-change' } as const
  follow(target)
  render(<AntigravityChatAuthForm owner={target} disabled={false} />)
  await waitFor(() => expect(screen.getByRole('combobox')).toBeEnabled())
  expect(screen.getByRole('button', { name: 'Apply account settings' })).toBeDisabled()
  await act(async () => {
    streams.handlers.get(key(target))?.onEvent({ revision: 1, auth: 'unknown', flow: null })
  })
  await waitFor(() =>
    expect(screen.getByLabelText('Google Cloud project')).toHaveValue('enterprise-project')
  )
  await user.click(screen.getByRole('combobox'))
  await user.click(screen.getByRole('option', { name: 'Google account (personal)' }))
  expect(screen.getByRole('button', { name: 'Apply account settings' })).toBeEnabled()
})

it('refreshes the saved method after reconnecting to a restarted host with the same revision', async () => {
  const target = { kind: 'environment', environmentId: 'restarted-host' } as const
  vi.mocked(callAntigravityChatAuthConfig)
    .mockResolvedValueOnce({ method: 'oauth-personal' })
    .mockResolvedValue({
      method: 'oauth-business',
      gcpProject: 'persisted-enterprise-project',
      gcpLocation: 'us-central1'
    })
  follow(target)
  render(<AntigravityChatAuthForm owner={target} disabled={false} />)
  await waitFor(() => expect(screen.getByRole('combobox')).toBeEnabled())
  expect(screen.getByRole('button', { name: 'Apply account settings' })).toBeDisabled()
  vi.useFakeTimers()
  await act(async () => {
    streams.handlers.get(key(target))?.onClose()
    await vi.advanceTimersByTimeAsync(1000)
  })
  vi.useRealTimers()
  await waitFor(() =>
    expect(screen.getByLabelText('Google Cloud project')).toHaveValue(
      'persisted-enterprise-project'
    )
  )
  expect(screen.getByRole('combobox')).toHaveTextContent('Gemini Enterprise')
})
