// @vitest-environment happy-dom

import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { PublicKnownRuntimeEnvironment } from '../../../../shared/runtime-environments'
import { useAppStore } from '@/store'
import { RuntimeDefaultHostRow } from './runtime-default-host-row'

const initialState = useAppStore.getInitialState()
afterEach(() => {
  cleanup()
  useAppStore.setState(initialState, true)
})

const wslHost: PublicKnownRuntimeEnvironment = {
  id: 'wsl:ubuntu',
  name: 'Ubuntu',
  createdAt: 1,
  updatedAt: 1,
  lastUsedAt: null,
  runtimeId: null,
  endpoints: [{ id: 'ws', kind: 'websocket', label: 'WSL', endpoint: 'ws://127.0.0.1:7001' }],
  preferredEndpointId: 'ws'
}

function renderRow(activeValue: string): void {
  render(
    <RuntimeDefaultHostRow
      allowLocalRuntime
      activeValue={activeValue}
      environments={[]}
      isBusy={false}
      onValueChange={vi.fn()}
    />
  )
}

// The default can be a host the server list leaves out; it must stay visible and changeable.
it('shows the selector for a default that is not this computer', () => {
  useAppStore.setState({ runtimeEnvironments: [wslHost] })
  renderRow(wslHost.id)
  expect(screen.queryByText(/until you add a server/)).toBeNull()
  expect(screen.getByRole('combobox').textContent).toContain('Ubuntu')
})
