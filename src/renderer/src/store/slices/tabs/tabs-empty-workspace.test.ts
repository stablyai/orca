// SLEEP-HOME-REGRESSION (terminal-only, n51): Sleep on a paired cloud workspace on screen closed its
// last terminal tab as the host stopped it, and closing the last tab landed on Home. Held asleep on
// screen, the workspace stays selected with no tab; the asleep view covers it.
import { afterEach, describe, expect, it } from 'vitest'
import { landsOnEmptiedWorktree } from './tabs-empty-workspace'
import { holdWorktreeSleepView, resetWorktreeSleepViewForTests } from '@/lib/worktree-sleep-view'

const emptied = {
  activeWorktreeId: 'ws',
  unifiedTabsByWorktree: {},
  tabsByWorktree: {},
  browserTabsByWorktree: {},
  openFiles: [],
  layoutByWorktree: {},
  groupsByWorktree: {}
}

afterEach(() => resetWorktreeSleepViewForTests())

describe('closing the last tab of the workspace on screen', () => {
  it('lands on Home', () => {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the check reads only these fields, all empty.
    expect(landsOnEmptiedWorktree(emptied as never, 'ws', 0)).toBe(true)
  })

  it('stays on a cloud workspace held asleep on screen (its last terminal closed by the sleep)', () => {
    holdWorktreeSleepView('ws')
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the check reads only these fields, all empty.
    expect(landsOnEmptiedWorktree(emptied as never, 'ws', 0)).toBe(false)
  })
})
