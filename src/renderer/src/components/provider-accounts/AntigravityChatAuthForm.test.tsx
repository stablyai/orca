// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, expect, it, vi } from 'vitest'
import {
  callAntigravityChatApiKey,
  callAntigravityChatAuthConfig
} from '@/runtime/provider-accounts/sign-in/runtime-antigravity-accounts-client'
import type { AntigravityChatAuthConfig } from '../../../../shared/agent-accounts/antigravity/antigravity-chat-auth-config'
import { AntigravityChatAuthForm } from './AntigravityChatAuthForm'

const host = vi.hoisted(() => ({ capability: 'supported' }))
vi.mock('@/runtime/native-chat/host-capabilities/structured-agent-session-host-capability', () => ({
  useStructuredAgentSessionHostCapabilityState: () => host.capability
}))
vi.mock('@/runtime/provider-accounts/sign-in/antigravity-chat-auth-detection', () => ({
  refreshAntigravityChatAuthDetection: vi.fn(async () => true)
}))
vi.mock('@/runtime/provider-accounts/sign-in/runtime-antigravity-accounts-client', () => ({
  callAntigravityChatAuthConfig: vi.fn(),
  callAntigravityChatApiKey: vi.fn()
}))

afterEach(() => {
  cleanup()
  vi.mocked(callAntigravityChatAuthConfig).mockReset()
  vi.mocked(callAntigravityChatApiKey).mockReset()
  host.capability = 'supported'
})

const owner = { kind: 'local' } as const

function savedAs(saved: AntigravityChatAuthConfig) {
  vi.mocked(callAntigravityChatAuthConfig).mockImplementation(async (_owner, config) =>
    config === undefined ? saved : config
  )
}

it('saves a method as soon as it is picked and shows the key field for a key', async () => {
  savedAs({ method: 'oauth-personal' })
  vi.mocked(callAntigravityChatApiKey).mockResolvedValue({ saved: false, inEnvironment: false })
  const user = userEvent.setup()
  render(<AntigravityChatAuthForm owner={owner} disabled={false} />)
  await waitFor(() => expect(screen.getByRole('combobox')).toBeEnabled())
  expect(screen.getByRole('combobox')).toHaveTextContent("agy's Google sign-in")

  await user.click(screen.getByRole('combobox'))
  await user.click(screen.getByRole('option', { name: /Gemini API key/ }))

  expect(callAntigravityChatAuthConfig).toHaveBeenLastCalledWith(owner, {
    method: 'gemini-api-key'
  })
  expect(await screen.findByText(/No key yet/)).toBeInTheDocument()
})

it('says a key from the environment is used, and saves and removes a pasted one', async () => {
  savedAs({ method: 'gemini-api-key' })
  vi.mocked(callAntigravityChatApiKey).mockImplementation(async (_owner, action) =>
    action.kind === 'save'
      ? { saved: true, inEnvironment: true }
      : { saved: false, inEnvironment: true }
  )
  const user = userEvent.setup()
  render(<AntigravityChatAuthForm owner={owner} disabled={false} />)
  expect(await screen.findByText(/Using GEMINI_API_KEY from your environment/)).toBeInTheDocument()

  await user.type(screen.getByLabelText(/Gemini API key/), 'AIza-pasted')
  await user.click(screen.getByRole('button', { name: 'Save' }))
  expect(callAntigravityChatApiKey).toHaveBeenCalledWith(owner, {
    kind: 'save',
    apiKey: 'AIza-pasted'
  })
  expect(await screen.findByText(/Key saved on this host/)).toBeInTheDocument()

  await user.click(screen.getByRole('button', { name: 'Remove' }))
  expect(callAntigravityChatApiKey).toHaveBeenLastCalledWith(owner, { kind: 'clear' })
})

it('saves the gcloud project when the field is left', async () => {
  savedAs({ method: 'agent-platform' })
  const user = userEvent.setup()
  render(<AntigravityChatAuthForm owner={owner} disabled={false} />)
  const project = await screen.findByLabelText('Google Cloud project')
  await waitFor(() => expect(project).toBeEnabled())
  await user.type(project, 'my-project')
  await user.tab()
  expect(callAntigravityChatAuthConfig).toHaveBeenLastCalledWith(owner, {
    method: 'agent-platform',
    gcpProject: 'my-project'
  })
})

it("shows an older host's Enterprise choice as agy's Google sign-in", async () => {
  savedAs({ method: 'oauth-business', gcpProject: 'license', gcpLocation: 'us' })
  render(<AntigravityChatAuthForm owner={owner} disabled={false} />)
  await waitFor(() =>
    expect(screen.getByRole('combobox')).toHaveTextContent("agy's Google sign-in")
  )
})

it('offers nothing to a host that cannot save a method', () => {
  host.capability = 'unsupported'
  const { container } = render(<AntigravityChatAuthForm owner={owner} disabled={false} />)
  expect(container).toBeEmptyDOMElement()
})
