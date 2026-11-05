// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, expect, it, vi } from 'vitest'
import { AntigravityChatAuthForm } from './AntigravityChatAuthForm'
import { callAntigravityChatAuthConfig } from '@/runtime/runtime-antigravity-accounts-client'

vi.mock('@/runtime/structured-agent-session-host-capability', () => ({
  useStructuredAgentSessionHostCapabilityState: () => 'supported'
}))
vi.mock('@/runtime/runtime-antigravity-accounts-client', () => ({
  callAntigravityChatAuthConfig: vi.fn()
}))
afterEach(() => {
  cleanup()
  vi.resetAllMocks()
})

it('applies a complete Enterprise choice to the selected execution host, keeping inputs on save failure', async () => {
  const target = { kind: 'environment', environmentId: 'host-enterprise' } as const
  const personal = { method: 'oauth-personal' } as const
  vi.mocked(callAntigravityChatAuthConfig)
    .mockResolvedValueOnce(personal)
    .mockRejectedValueOnce(new Error('Could not save account settings'))
  const user = userEvent.setup()
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
