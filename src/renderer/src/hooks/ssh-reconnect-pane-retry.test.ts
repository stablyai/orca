import { describe, expect, it } from 'vitest'
import { shouldRetryPaneSpawnOnSshReconnect } from './ssh-reconnect-pane-retry'

describe('shouldRetryPaneSpawnOnSshReconnect', () => {
  it('retries tabs with no ptyId at all', () => {
    expect(
      shouldRetryPaneSpawnOnSshReconnect({
        targetId: 'conn-1',
        tabPtyId: null,
        deferredSessionId: undefined
      })
    ).toBe(true)
  })

  it('retries tabs still holding a deferred session for this target', () => {
    // Why: the stale wake-hint ptyId reads as live, but an unconsumed deferred
    // entry proves no pane ever reattached — the pane is stranded.
    expect(
      shouldRetryPaneSpawnOnSshReconnect({
        targetId: 'conn-1',
        tabPtyId: 'ssh:conn-1@@pty-7',
        deferredSessionId: 'ssh:conn-1@@pty-7'
      })
    ).toBe(true)
  })

  it('leaves tabs whose deferred entry was already consumed alone', () => {
    expect(
      shouldRetryPaneSpawnOnSshReconnect({
        targetId: 'conn-1',
        tabPtyId: 'ssh:conn-1@@pty-7',
        deferredSessionId: undefined
      })
    ).toBe(false)
  })

  it('ignores deferred sessions that belong to another target', () => {
    expect(
      shouldRetryPaneSpawnOnSshReconnect({
        targetId: 'conn-1',
        tabPtyId: 'ssh:conn-2@@pty-3',
        deferredSessionId: 'ssh:conn-2@@pty-3'
      })
    ).toBe(false)
  })
})
