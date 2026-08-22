import { describe, expect, it } from 'vitest'
import { shouldDeferInitialTerminalCreation } from './remote-workspace-pending-hydration'

const TARGET = 'ssh-target-1'
const WT = 'repo-1::/home/user/project'
const PATH = '/home/user/project'

describe('shouldDeferInitialTerminalCreation', () => {
  it('never defers a local worktree', () => {
    expect(shouldDeferInitialTerminalCreation(WT, null, new Set(), {})).toBe(false)
  })

  it('defers while the owning repo is unknown', () => {
    expect(shouldDeferInitialTerminalCreation(WT, undefined, new Set(), {})).toBe(true)
  })

  it('defers a remote worktree until its target has hydrated once', () => {
    expect(shouldDeferInitialTerminalCreation(WT, TARGET, new Set(), {})).toBe(true)
    expect(shouldDeferInitialTerminalCreation(WT, TARGET, new Set([TARGET]), {})).toBe(false)
  })

  it('defers a hydrated target while the worktree path awaits deferred hydration', () => {
    const hydrated = new Set([TARGET])
    expect(shouldDeferInitialTerminalCreation(WT, TARGET, hydrated, { [TARGET]: [PATH] })).toBe(
      true
    )
    expect(
      shouldDeferInitialTerminalCreation(WT, TARGET, hydrated, { [TARGET]: ['/elsewhere'] })
    ).toBe(false)
    expect(shouldDeferInitialTerminalCreation(WT, TARGET, hydrated, {})).toBe(false)
  })

  it('ignores pending paths registered for a different target', () => {
    expect(
      shouldDeferInitialTerminalCreation(WT, TARGET, new Set([TARGET]), {
        'ssh-target-2': [PATH]
      })
    ).toBe(false)
  })
})
