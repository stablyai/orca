// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { RuntimeServerEdgeAuthAction } from './runtime-server-edge-auth-action'
const environment = {
  id: 'env-1',
  name: 'server',
  createdAt: 1,
  updatedAt: 1,
  pairingRevision: 3,
  lastUsedAt: null,
  runtimeId: null,
  preferredEndpointId: 'edge',
  endpoints: [
    { id: 'edge', kind: 'websocket' as const, label: 'Edge', endpoint: 'wss://orca.example' }
  ]
}
afterEach(() => cleanup())
describe('existing server edge credential action', () => {
  it('shows status without prefilling secrets and clears explicitly under the expected revision', async () => {
    const clearEdgeAuth = vi.fn().mockResolvedValue({ configured: false, unreadable: false })
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        runtimeEnvironments: {
          getEdgeAuthStatus: vi.fn().mockResolvedValue({ configured: true, unreadable: false }),
          saveEdgeAuth: vi.fn(),
          clearEdgeAuth
        }
      }
    })
    render(
      <RuntimeServerEdgeAuthAction
        environment={environment}
        onClose={vi.fn()}
        onChanged={vi.fn()}
      />
    )
    await screen.findByText('Credentials are saved. Enter new values to replace them.')
    expect(screen.getByLabelText('Header 1 value').getAttribute('value')).toBe('')
    fireEvent.click(screen.getByRole('button', { name: 'Clear credentials' }))
    await waitFor(() =>
      expect(clearEdgeAuth).toHaveBeenCalledWith({
        environmentId: 'env-1',
        expectedPairingRevision: 3
      })
    )
  })
  it('ignores a status load that completes after the dialog closes', async () => {
    let finish: (value: { configured: boolean; unreadable: boolean }) => void = () => {}
    const getEdgeAuthStatus = vi.fn(
      () =>
        new Promise((resolve) => {
          finish = resolve
        })
    )
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { runtimeEnvironments: { getEdgeAuthStatus } }
    })
    const onChanged = vi.fn()
    const view = render(
      <RuntimeServerEdgeAuthAction
        environment={environment}
        onClose={vi.fn()}
        onChanged={onChanged}
      />
    )
    view.unmount()
    await act(async () => finish({ configured: true, unreadable: false }))
    expect(onChanged).not.toHaveBeenCalled()
  })
})
