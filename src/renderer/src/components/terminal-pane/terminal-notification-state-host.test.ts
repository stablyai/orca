import { describe, expect, it } from 'vitest'
import { toRemoteRuntimePtyId } from '../../../../shared/remote-runtime-pty-id'
import { isCurrentKnownPaneKey } from './terminal-notification-state'

describe('notification pane host ownership', () => {
  it('rejects a current pane owned by a different runtime host', () => {
    const paneKey = 'tab-1:11111111-1111-4111-8111-111111111111'
    const state = {
      tabsByWorktree: {
        'wt-1': [{ id: 'tab-1', ptyId: toRemoteRuntimePtyId('pty-1', 'env-other') }]
      },
      terminalLayoutsByTabId: {},
      suppressedPtyExitIds: {}
    } as never

    expect(isCurrentKnownPaneKey(state, 'wt-1', paneKey, 'runtime:env-1')).toBe(false)
    expect(isCurrentKnownPaneKey(state, 'wt-1', paneKey, 'runtime:env-other')).toBe(true)
  })

  it('rejects an exact target whose host cannot be proven from a PTY', () => {
    const state = {
      tabsByWorktree: { 'wt-1': [{ id: 'tab-1', ptyId: null }] },
      terminalLayoutsByTabId: {},
      suppressedPtyExitIds: {}
    } as never

    expect(
      isCurrentKnownPaneKey(
        state,
        'wt-1',
        'tab-1:11111111-1111-4111-8111-111111111111',
        'runtime:env-1'
      )
    ).toBe(false)
  })
})
