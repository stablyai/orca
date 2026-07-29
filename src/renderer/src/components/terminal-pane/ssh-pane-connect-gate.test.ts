import { describe, expect, it } from 'vitest'
import { resolveSshPaneConnectGate } from './ssh-pane-connect-gate'

const BASE = {
  connectionId: 'conn-1',
  sshStatus: undefined as string | undefined,
  isDeferredTarget: false,
  restoredLeafSessionId: null as string | null,
  deferredTabSessionId: undefined as string | undefined,
  tabPtyId: null as string | null,
  hasLeafSessionMap: false
}

describe('resolveSshPaneConnectGate', () => {
  it('routes a disconnected target through the deferred flow even without a session id', () => {
    const gate = resolveSshPaneConnectGate(BASE)
    expect(gate).toEqual({ pendingSessionId: null, enterDeferredFlow: true, sshConnected: false })
  })

  it('skips the deferred flow for a connected target with no restore state', () => {
    const gate = resolveSshPaneConnectGate({ ...BASE, sshStatus: 'connected' })
    expect(gate).toEqual({ pendingSessionId: null, enterDeferredFlow: false, sshConnected: true })
  })

  it('falls back to the tab-level app SSH pty id when the deferred maps missed the tab', () => {
    const gate = resolveSshPaneConnectGate({ ...BASE, tabPtyId: 'ssh:conn-1@@pty-7' })
    expect(gate.pendingSessionId).toBe('ssh:conn-1@@pty-7')
    expect(gate.enterDeferredFlow).toBe(true)
  })

  it('ignores a tab pty id that belongs to a different connection', () => {
    const gate = resolveSshPaneConnectGate({ ...BASE, tabPtyId: 'ssh:conn-2@@pty-7' })
    expect(gate.pendingSessionId).toBeNull()
  })

  it('ignores the tab-level fallback when a per-leaf session map exists', () => {
    // Why: every leaf of a split mounts its own pane; the tab-level id must
    // not be reattached by all of them.
    const gate = resolveSshPaneConnectGate({
      ...BASE,
      tabPtyId: 'ssh:conn-1@@pty-7',
      hasLeafSessionMap: true
    })
    expect(gate.pendingSessionId).toBeNull()
  })

  it('ignores the tab-level fallback once connected — live panes attach normally', () => {
    const gate = resolveSshPaneConnectGate({
      ...BASE,
      sshStatus: 'connected',
      tabPtyId: 'ssh:conn-1@@pty-7'
    })
    expect(gate.pendingSessionId).toBeNull()
    expect(gate.enterDeferredFlow).toBe(false)
  })

  it('prefers the restored leaf session, then the deferred map, then the fallback', () => {
    const gate = resolveSshPaneConnectGate({
      ...BASE,
      restoredLeafSessionId: 'ssh:conn-1@@pty-1',
      deferredTabSessionId: 'ssh:conn-1@@pty-2',
      tabPtyId: 'ssh:conn-1@@pty-3'
    })
    expect(gate.pendingSessionId).toBe('ssh:conn-1@@pty-1')
  })

  it('still enters the deferred flow for deferred targets that already connected', () => {
    // Why: connecting via Settings does not remove the target from the
    // deferred list; the gate consumes it and reattaches.
    const gate = resolveSshPaneConnectGate({
      ...BASE,
      sshStatus: 'connected',
      isDeferredTarget: true
    })
    expect(gate.enterDeferredFlow).toBe(true)
  })

  it('does not force a connect for runtime-owned targets', () => {
    // Why: their relay health is owned by the runtime layer; users cannot
    // connect to them directly, so a reconnect flow would strand the pane.
    const gate = resolveSshPaneConnectGate({
      ...BASE,
      connectionId: 'runtime-ssh-env-1'
    })
    expect(gate.enterDeferredFlow).toBe(false)
  })
})
