import { describe, expect, it } from 'vitest'
import { resolveSshPaneConnectGate, resolveSshPaneTargetPresence } from './ssh-pane-connect-gate'

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

describe('resolveSshPaneTargetPresence', () => {
  const bucket = (overrides?: {
    targetLabels?: Map<string, string>
    removedTargetLabels?: Map<string, string>
    targetsHydrated?: boolean
  }) => ({
    targetLabels: overrides?.targetLabels ?? new Map<string, string>(),
    removedTargetLabels: overrides?.removedTargetLabels ?? new Map<string, string>(),
    targetsHydrated: overrides?.targetsHydrated ?? true
  })

  it('reports a locally known target as present', () => {
    expect(
      resolveSshPaneTargetPresence({
        connectionId: 'conn-1',
        environmentId: null,
        localTargetLabels: new Map([['conn-1', 'Box']]),
        environmentBucket: null
      })
    ).toBe('present')
  })

  it('reports a target missing from the hydrated local map as removed', () => {
    expect(
      resolveSshPaneTargetPresence({
        connectionId: 'conn-1',
        environmentId: null,
        localTargetLabels: new Map(),
        environmentBucket: null
      })
    ).toBe('removed')
  })

  it('reports unknown while the local map is not hydrated', () => {
    expect(
      resolveSshPaneTargetPresence({
        connectionId: 'conn-1',
        environmentId: null,
        localTargetLabels: undefined,
        environmentBucket: null
      })
    ).toBe('unknown')
  })

  it('always treats runtime-owned targets as present', () => {
    expect(
      resolveSshPaneTargetPresence({
        connectionId: 'runtime-ssh-env-1',
        environmentId: 'env-1',
        localTargetLabels: new Map(),
        environmentBucket: null
      })
    ).toBe('present')
  })

  // Regression (#9276): a hub-owned SSH target lives only in the owner
  // environment's bucket; reading the local map marked it removed and the
  // pane silently never spawned.
  it('reports a hub-owned target in the owner bucket as present despite empty local maps', () => {
    expect(
      resolveSshPaneTargetPresence({
        connectionId: 'conn-1',
        environmentId: 'env-1',
        localTargetLabels: new Map(),
        environmentBucket: bucket({ targetLabels: new Map([['conn-1', 'Hub box']]) })
      })
    ).toBe('present')
  })

  it('reports a hub-side tombstoned target as removed', () => {
    expect(
      resolveSshPaneTargetPresence({
        connectionId: 'conn-1',
        environmentId: 'env-1',
        localTargetLabels: new Map([['conn-1', 'Local twin']]),
        environmentBucket: bucket({ removedTargetLabels: new Map([['conn-1', 'Hub box']]) })
      })
    ).toBe('removed')
  })

  it('reports a target absent from a hydrated owner bucket as removed', () => {
    expect(
      resolveSshPaneTargetPresence({
        connectionId: 'conn-1',
        environmentId: 'env-1',
        localTargetLabels: new Map([['conn-1', 'Local twin']]),
        environmentBucket: bucket()
      })
    ).toBe('removed')
  })

  it('reports unknown while the owner bucket is missing', () => {
    expect(
      resolveSshPaneTargetPresence({
        connectionId: 'conn-1',
        environmentId: 'env-1',
        localTargetLabels: new Map(),
        environmentBucket: null
      })
    ).toBe('unknown')
  })

  it('reports unknown while the owner bucket is not hydrated', () => {
    expect(
      resolveSshPaneTargetPresence({
        connectionId: 'conn-1',
        environmentId: 'env-1',
        localTargetLabels: new Map(),
        environmentBucket: bucket({ targetsHydrated: false })
      })
    ).toBe('unknown')
  })
})
