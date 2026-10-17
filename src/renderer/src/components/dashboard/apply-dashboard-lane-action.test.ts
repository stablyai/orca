import { describe, expect, it } from 'vitest'
import type { TerminalTab } from '../../../../shared/terminal-tab-types'
import { createLivePaneKeyPredicate } from './apply-dashboard-lane-action'

function tab(id: string): TerminalTab {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the predicate reads only tab ids.
  return { id } as TerminalTab
}

const LEAF = '6f1c2b0e-8a4d-4c3e-9b7a-1d2e3f4a5b6c'

describe('createLivePaneKeyPredicate', () => {
  it('keeps panes whose tab still exists in any workspace, sleeping ones included', () => {
    const isLive = createLivePaneKeyPredicate({
      tabsByWorktree: { awake: [tab('tab-a')], asleep: [tab('tab-b')] }
    })
    expect(isLive(`tab-a:${LEAF}`)).toBe(true)
    expect(isLive(`tab-b:${LEAF}`)).toBe(true)
  })

  it('drops panes of closed tabs and malformed keys', () => {
    const isLive = createLivePaneKeyPredicate({ tabsByWorktree: { w: [tab('tab-a')] } })
    expect(isLive(`tab-gone:${LEAF}`)).toBe(false)
    expect(isLive('not-a-pane-key')).toBe(false)
  })
})
