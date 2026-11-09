// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { PublicKnownRuntimeEnvironment } from '../../../../../shared/remote-runtime/host-catalog/runtime-environments'
import { SettingsHostScopePicker } from './SettingsHostScopePicker'

const environment: PublicKnownRuntimeEnvironment = {
  id: 'server-a',
  name: 'Berlin build server',
  createdAt: 1,
  updatedAt: 1,
  lastUsedAt: null,
  runtimeId: null,
  endpoints: [
    { id: 'ws-a', kind: 'websocket', label: 'WebSocket', endpoint: 'ws://localhost:6768' }
  ],
  preferredEndpointId: 'ws-a'
}

afterEach(cleanup)

it('keeps a removed host selected and lets the user search for another host', () => {
  const onChoose = vi.fn()
  render(
    <SettingsHostScopePicker
      scope={{ target: { kind: 'environment', environmentId: 'removed' }, available: false }}
      environments={[environment]}
      onChoose={onChoose}
    />
  )

  const trigger = screen.getByRole('combobox', { name: 'Host' })
  expect(trigger.textContent).toContain('removed (unavailable)')
  fireEvent.click(trigger)
  const unavailableOption = screen.getByRole('option', { name: 'removed (unavailable)' })
  expect(unavailableOption.getAttribute('aria-disabled')).toBe('true')
  fireEvent.change(screen.getByRole('combobox', { name: 'Search hosts…' }), {
    target: { value: 'server-a' }
  })
  fireEvent.click(screen.getByRole('option', { name: 'Berlin build server' }))

  expect(onChoose).toHaveBeenCalledWith({ kind: 'environment', environmentId: 'server-a' })
})
