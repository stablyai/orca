// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { encodePairingOffer } from '../../../../shared/pairing'
import { RuntimeAddServerDialog } from './runtime-add-server-dialog'
vi.mock('@/store', () => ({ useAppStore: () => [] }))
afterEach(() => cleanup())
function link(endpoint: string, publicKeyB64 = 'synthetic-key') {
  return encodePairingOffer({ v: 2, endpoint, deviceToken: 'synthetic-device', publicKeyB64 })
}
const props = {
  open: true,
  name: 'server',
  busy: false,
  failure: null,
  onNameChange: vi.fn(),
  onAccessLinkChange: vi.fn(),
  onClose: vi.fn(),
  onSubmit: vi.fn()
}
describe('Add Server credential ownership', () => {
  it.each(['origin', 'identity'] as const)(
    'clears draft credentials after changing the %s',
    (kind) => {
      Object.defineProperty(window, 'api', {
        configurable: true,
        value: { runtimeEnvironments: { saveEdgeAuth: vi.fn() } }
      })
      const view = render(
        <RuntimeAddServerDialog {...props} accessLink={link('wss://orca.example')} />
      )
      fireEvent.change(screen.getByLabelText('Header 1 value'), {
        target: { value: 'synthetic-secret' }
      })
      view.rerender(
        <RuntimeAddServerDialog
          {...props}
          accessLink={
            kind === 'origin'
              ? link('wss://other.example')
              : link('wss://orca.example', 'another-key')
          }
        />
      )
      expect(screen.getByLabelText('Header 1 value').getAttribute('value')).toBe('')
    }
  )
  it('hides service-token fields in browser clients', () => {
    Object.defineProperty(window, 'api', { configurable: true, value: { runtimeEnvironments: {} } })
    render(<RuntimeAddServerDialog {...props} accessLink={link('wss://orca.example')} />)
    expect(screen.queryByLabelText('Header 1 value')).toBeNull()
  })
})
