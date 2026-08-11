import { describe, expect, it } from 'vitest'
import { buildCodexRestartNoticeKey } from './codex-restart-notice-key'

describe('codex restart notice key', () => {
  it('builds a stable notice key from account labels', () => {
    expect(
      buildCodexRestartNoticeKey({
        previousAccountLabel: 'Account A',
        nextAccountLabel: 'Account B'
      })
    ).toBe('account\u0000Account A\u0000Account B')
  })

  it('distinguishes a home-route notice from equal account labels', () => {
    expect(
      buildCodexRestartNoticeKey({
        previousAccountLabel: 'System default',
        nextAccountLabel: 'System default',
        homeRouteChanged: true
      })
    ).toBe('route\u0000System default\u0000System default')
  })
})
