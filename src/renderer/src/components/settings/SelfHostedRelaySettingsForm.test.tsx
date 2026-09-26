// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { SelfHostedRelaySettingsForm } from './SelfHostedRelaySettingsForm'

vi.mock('@/i18n/i18n', () => ({ translate: (_key: string, fallback: string) => fallback }))
vi.mock('sonner', () => ({ toast: { success: vi.fn() } }))
const configure = vi.fn()
beforeEach(() => {
  configure.mockReset().mockResolvedValue({ ok: true })
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: { mobile: { configureSelfHostedRelay: configure } }
  })
})
afterEach(cleanup)

it('shows a saved-key error when the initial status arrives after mounting', () => {
  const view = render(<SelfHostedRelaySettingsForm status={undefined} />)
  view.rerender(
    <SelfHostedRelaySettingsForm
      status={{ configured: false, status: 'offline', error: 'Unlock the OS keyring.' }}
    />
  )
  expect(screen.getByRole('alert')).toHaveTextContent('Unlock the OS keyring.')
  expect(screen.getByRole('button', { name: 'Remove configuration' })).toBeEnabled()
})

it('saves from the form, masks the key, and clears it after success', async () => {
  const user = userEvent.setup()
  render(<SelfHostedRelaySettingsForm status={undefined} />)
  expect(screen.getByRole('button', { name: 'Save Relay' })).toBeDisabled()
  await user.type(screen.getByLabelText('Relay URL'), 'https://relay.example.com')
  const key = screen.getByLabelText('Access key')
  expect(key).toHaveAttribute('type', 'password')
  await user.type(key, 'k'.repeat(64))
  await user.click(screen.getByRole('button', { name: 'Save Relay' }))
  expect(configure).toHaveBeenCalledWith({
    url: 'https://relay.example.com',
    accessKey: 'k'.repeat(64)
  })
  await waitFor(() => expect(key).toHaveValue(''))
})

it('keeps a failed save editable and displays the returned error', async () => {
  configure.mockResolvedValue({ ok: false, message: 'Unlock the OS keyring.' })
  const user = userEvent.setup()
  render(<SelfHostedRelaySettingsForm status={undefined} />)
  await user.type(screen.getByLabelText('Relay URL'), 'https://relay.example.com')
  await user.type(screen.getByLabelText('Access key'), 'k'.repeat(64))
  await user.click(screen.getByRole('button', { name: 'Save Relay' }))
  expect(await screen.findByRole('alert')).toHaveTextContent('Unlock the OS keyring.')
  expect(screen.getByRole('button', { name: 'Save Relay' })).toBeEnabled()
})

it('loads only the URL and can remove a saved configuration without entering the key', async () => {
  const user = userEvent.setup()
  render(
    <SelfHostedRelaySettingsForm
      status={{ configured: true, status: 'standby', url: 'https://relay.example.com' }}
    />
  )
  expect(screen.getByLabelText('Relay URL')).toHaveValue('https://relay.example.com')
  expect(screen.getByLabelText('Access key')).toHaveValue('')
  await user.click(screen.getByRole('button', { name: 'Remove configuration' }))
  expect(configure).toHaveBeenCalledWith(null)
  await waitFor(() => expect(screen.getByLabelText('Relay URL')).toHaveValue(''))
})
