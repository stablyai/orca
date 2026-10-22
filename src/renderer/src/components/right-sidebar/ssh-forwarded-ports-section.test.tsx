// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { PortForwardEntry } from '../../../../shared/ssh-types'
import { TooltipProvider } from '@/components/ui/tooltip'
import { useAppStore } from '@/store'
import { SshForwardedPortsSection } from './ssh-forwarded-ports-section'

const initialState = useAppStore.getInitialState()

const forward: PortForwardEntry = {
  id: 'fwd-1',
  connectionId: 'box',
  localPort: 3000,
  remoteHost: 'localhost',
  remotePort: 3000,
  label: 'web'
}
const remapped: PortForwardEntry = { ...forward, id: 'fwd-2', localPort: 13000, label: 'remapped' }

function renderSection(status: 'connected' | 'disconnected', forwards: PortForwardEntry[]) {
  useAppStore.setState({
    portForwardsByConnection: { box: forwards },
    sshConnectionStates: new Map([
      ['box', { targetId: 'box', status, error: null, reconnectAttempt: 0 }]
    ])
  })
  return render(
    <TooltipProvider>
      <SshForwardedPortsSection connectionId="box" />
    </TooltipProvider>
  )
}

afterEach(() => {
  cleanup()
  useAppStore.setState(initialState, true)
})

describe('SSH forwards for a managed server workspace', () => {
  it("lists the host's saved forwards", () => {
    renderSection('connected', [forward])
    expect(screen.getByText('web')).toBeTruthy()
  })

  it('opens the forward dialog for the SSH host under the server', () => {
    renderSection('connected', [])
    fireEvent.click(screen.getByRole('button', { name: /Add/ }))
    expect(screen.getByRole('dialog')).toBeTruthy()
  })

  it('cannot add a forward while the SSH host is down', () => {
    renderSection('disconnected', [])
    expect(screen.getByRole('button', { name: /Add/ }).hasAttribute('disabled')).toBe(true)
  })

  it("opens a forward's local address on this machine, where it listens", () => {
    const openUrl = vi.fn(async () => undefined)
    Object.defineProperty(window, 'api', { value: { shell: { openUrl } }, configurable: true })
    renderSection('connected', [remapped])
    fireEvent.click(screen.getByTitle(/Open in Browser/))
    expect(openUrl).toHaveBeenCalledWith('http://127.0.0.1:13000')
  })
})
