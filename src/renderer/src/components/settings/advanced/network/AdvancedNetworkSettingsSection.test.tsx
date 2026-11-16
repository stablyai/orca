// @vitest-environment happy-dom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { getDefaultSettings } from '../../../../../../shared/constants'
import { useAppStore } from '@/store/index'
import { AdvancedNetworkSettingsSection } from './AdvancedNetworkSettingsSection'

const originalState = useAppStore.getState()
afterEach(() => {
  cleanup()
  useAppStore.setState(originalState, true)
})

it('reveals the certificate controls when searching for TLS', () => {
  useAppStore.setState({ settingsSearchQuery: 'tls' })
  render(
    <AdvancedNetworkSettingsSection
      settings={getDefaultSettings('/tmp')}
      updateSettings={vi.fn()}
    />
  )

  expect(screen.getByRole('textbox', { name: 'Custom CA certificate (PEM)' })).toBeTruthy()
  expect(screen.getByRole('switch', { name: 'Ignore SSL certificate errors' })).toBeTruthy()
  expect(
    screen.getByRole('button', { name: 'Configure proxy' }).getAttribute('aria-expanded')
  ).toBe('true')
})
