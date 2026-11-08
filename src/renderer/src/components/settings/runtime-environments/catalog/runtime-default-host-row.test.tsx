// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { PublicKnownRuntimeEnvironment } from '../../../../../../shared/remote-runtime/host-catalog/runtime-environments'
import { RuntimeDefaultHostRow } from './runtime-default-host-row'

const environments: PublicKnownRuntimeEnvironment[] = [
  {
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
  },
  {
    id: 'server-b',
    name: 'Oslo test server',
    createdAt: 2,
    updatedAt: 2,
    lastUsedAt: null,
    runtimeId: null,
    endpoints: [
      { id: 'ws-b', kind: 'websocket', label: 'WebSocket', endpoint: 'ws://localhost:6769' }
    ],
    preferredEndpointId: 'ws-b'
  }
]

afterEach(cleanup)

it('searches hosts and requests the selected runtime value', () => {
  const onValueChange = vi.fn()
  render(
    <RuntimeDefaultHostRow
      allowLocalRuntime
      activeValue="server-a"
      environments={environments}
      isBusy={false}
      onValueChange={onValueChange}
    />
  )

  fireEvent.click(screen.getByRole('combobox', { name: 'New projects open on' }))
  fireEvent.change(screen.getByRole('combobox', { name: 'Search hosts…' }), {
    target: { value: 'oslo' }
  })
  fireEvent.click(screen.getByRole('option', { name: 'Oslo test server' }))

  expect(onValueChange).toHaveBeenCalledWith('server-b')
})
