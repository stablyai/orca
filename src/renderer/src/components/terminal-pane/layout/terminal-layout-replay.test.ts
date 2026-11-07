import { describe, expect, it, vi } from 'vitest'
import { replayTerminalLayout } from './terminal-layout-replay'

const LEAF_1 = '11111111-1111-4111-8111-111111111111'

const LEAF_2 = '22222222-2222-4222-8222-222222222222'

const LEAF_3 = '33333333-3333-4333-8333-333333333333'

const LEAF_4 = '44444444-4444-4444-8444-444444444444'

describe('replayTerminalLayout', () => {
  function createReplayManager() {
    const createInitialPane = vi.fn((opts?: { leafId?: string }) => ({
      id: 1,
      leafId: opts?.leafId ?? LEAF_4
    }))
    return {
      createInitialPane,
      splitPane: vi.fn()
    }
  }

  it('preserves the active leaf when replaying a single-pane snapshot without a root', () => {
    const manager = createReplayManager()

    const restored = replayTerminalLayout(
      manager as unknown as Parameters<typeof replayTerminalLayout>[0],
      {
        root: null,
        activeLeafId: LEAF_1,
        expandedLeafId: null
      },
      true
    )

    expect(manager.createInitialPane).toHaveBeenCalledWith({ focus: true, leafId: LEAF_1 })
    expect(restored.get(LEAF_1)).toBe(1)
  })

  it('prefers the active leaf over multiple retained PTY bindings in a rootless snapshot', () => {
    const manager = createReplayManager()

    const restored = replayTerminalLayout(
      manager as unknown as Parameters<typeof replayTerminalLayout>[0],
      {
        root: null,
        activeLeafId: LEAF_3,
        expandedLeafId: null,
        ptyIdsByLeafId: {
          [LEAF_1]: 'pty-1',
          [LEAF_2]: 'pty-2'
        }
      },
      false
    )

    expect(manager.createInitialPane).toHaveBeenCalledWith({ focus: false, leafId: LEAF_3 })
    expect(restored.get(LEAF_3)).toBe(1)
  })

  it('preserves a bound PTY leaf when the rootless snapshot has no active leaf', () => {
    const manager = createReplayManager()

    const restored = replayTerminalLayout(
      manager as unknown as Parameters<typeof replayTerminalLayout>[0],
      {
        root: null,
        activeLeafId: null,
        expandedLeafId: null,
        ptyIdsByLeafId: {
          [LEAF_2]: 'pty-2'
        }
      },
      false
    )

    expect(manager.createInitialPane).toHaveBeenCalledWith({ focus: false, leafId: LEAF_2 })
    expect(restored.get(LEAF_2)).toBe(1)
  })

  it('does not pick an arbitrary PTY leaf when a rootless snapshot has multiple bindings', () => {
    const manager = createReplayManager()

    const restored = replayTerminalLayout(
      manager as unknown as Parameters<typeof replayTerminalLayout>[0],
      {
        root: null,
        activeLeafId: null,
        expandedLeafId: null,
        ptyIdsByLeafId: {
          [LEAF_1]: 'pty-1',
          [LEAF_2]: 'pty-2'
        }
      },
      false
    )

    expect(manager.createInitialPane).toHaveBeenCalledWith({ focus: false, leafId: undefined })
    expect(restored.get(LEAF_4)).toBe(1)
  })
})
