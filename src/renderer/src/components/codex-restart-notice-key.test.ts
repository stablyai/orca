import { describe, expect, it } from 'vitest'
import { buildCodexRestartNoticeKey } from './codex-restart-notice-key'

describe('codex restart notice key', () => {
  it('builds a stable notice key from account labels', () => {
    expect(
      buildCodexRestartNoticeKey({
        previousAccountLabel: 'Account A',
        nextAccountLabel: 'Account B'
      })
    ).toBe('Account A\u0000Account B')
  })
})
