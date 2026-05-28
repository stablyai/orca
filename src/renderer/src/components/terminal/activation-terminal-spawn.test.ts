import { describe, expect, it } from 'vitest'
import { shouldDeferActivationTerminalSpawn } from './activation-terminal-spawn'

describe('shouldDeferActivationTerminalSpawn', () => {
  it('defers click-created tabs without a live PTY', () => {
    expect(
      shouldDeferActivationTerminalSpawn({
        tab: { id: 'tab-1', ptyId: null, pendingActivationSpawn: true },
        ptyIdsByTabId: {},
        hasQueuedLaunch: false
      })
    ).toBe(true)
  })

  it('defers restored stale PTY ids', () => {
    expect(
      shouldDeferActivationTerminalSpawn({
        tab: { id: 'tab-1', ptyId: 'pty-old', pendingActivationSpawn: true },
        ptyIdsByTabId: { 'tab-1': [] },
        hasQueuedLaunch: false
      })
    ).toBe(true)
  })

  it('does not defer explicit startup tabs or live reattach tabs', () => {
    expect(
      shouldDeferActivationTerminalSpawn({
        tab: { id: 'tab-1', ptyId: null, pendingActivationSpawn: true },
        ptyIdsByTabId: {},
        hasQueuedLaunch: true
      })
    ).toBe(false)
    expect(
      shouldDeferActivationTerminalSpawn({
        tab: { id: 'tab-2', ptyId: 'pty-live', pendingActivationSpawn: true },
        ptyIdsByTabId: { 'tab-2': ['pty-live'] },
        hasQueuedLaunch: false
      })
    ).toBe(false)
  })
})
