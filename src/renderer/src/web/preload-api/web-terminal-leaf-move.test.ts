// @vitest-environment happy-dom

import { describe, expect, it } from 'vitest'
import { createPtyApi } from './web-terminal-api'

const request = {
  worktreeId: 'repo-1::/tmp/wt',
  sourceTabId: 'tab-source',
  targetTabId: 'tab-target',
  targetLeafId: '11111111-1111-4111-8111-111111111111',
  leafId: '22222222-2222-4222-8222-222222222222',
  ptyId: 'pty-1',
  placement: { kind: 'beside', side: 'right' }
} as const

describe('the web client PTY api', () => {
  it('refuses a join into a tab: no local main owns a paired client layout', async () => {
    await expect(createPtyApi().moveLeafIntoTab?.(request)).resolves.toEqual({
      status: 'refused',
      reason: 'unsupported'
    })
  })
})
