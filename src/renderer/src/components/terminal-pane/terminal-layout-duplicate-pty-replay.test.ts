import { describe, expect, it, vi } from 'vitest'
import { replayTerminalLayout } from './layout-serialization'

const LEAF_1 = '11111111-1111-4111-8111-111111111111'
const LEAF_2 = '22222222-2222-4222-8222-222222222222'
const LEAF_3 = '33333333-3333-4333-8333-333333333333'

describe('duplicate PTY layout replay', () => {
  it('replays one surface when restored leaves point to the same PTY', () => {
    const manager = {
      createInitialPane: vi.fn((opts?: { leafId?: string }) => ({
        id: 1,
        leafId: opts?.leafId ?? LEAF_1
      })),
      splitPane: vi.fn()
    }

    const restored = replayTerminalLayout(
      manager as unknown as Parameters<typeof replayTerminalLayout>[0],
      {
        root: {
          type: 'split',
          direction: 'vertical',
          first: { type: 'leaf', leafId: LEAF_1 },
          second: { type: 'leaf', leafId: LEAF_2 }
        },
        activeLeafId: LEAF_2,
        expandedLeafId: null,
        ptyIdsByLeafId: {
          [LEAF_1]: 'pty-agent',
          [LEAF_2]: 'pty-agent'
        }
      },
      true
    )

    expect(manager.createInitialPane).toHaveBeenCalledWith({ focus: true, leafId: LEAF_2 })
    expect(manager.splitPane).not.toHaveBeenCalled()
    expect([...restored]).toEqual([[LEAF_2, 1]])
  })

  it('reattaches the retained PTY leaf from rootless duplicate state', () => {
    const manager = {
      createInitialPane: vi.fn((opts?: { leafId?: string }) => ({
        id: 1,
        leafId: opts?.leafId ?? LEAF_2
      })),
      splitPane: vi.fn()
    }

    const restored = replayTerminalLayout(
      manager as unknown as Parameters<typeof replayTerminalLayout>[0],
      {
        root: null,
        activeLeafId: null,
        expandedLeafId: null,
        ptyIdsByLeafId: {
          [LEAF_1]: 'pty-agent',
          [LEAF_2]: 'pty-agent'
        }
      },
      true
    )

    expect(manager.createInitialPane).toHaveBeenCalledWith({ focus: true, leafId: LEAF_1 })
    expect(manager.splitPane).not.toHaveBeenCalled()
    expect([...restored]).toEqual([[LEAF_1, 1]])
  })

  it('preserves a rootless pending leaf while pruning duplicate PTY ownership', () => {
    const manager = {
      createInitialPane: vi.fn((opts?: { leafId?: string }) => ({
        id: 1,
        leafId: opts?.leafId ?? LEAF_2
      })),
      splitPane: vi.fn()
    }

    const restored = replayTerminalLayout(
      manager as unknown as Parameters<typeof replayTerminalLayout>[0],
      {
        root: null,
        activeLeafId: LEAF_3,
        expandedLeafId: null,
        ptyIdsByLeafId: {
          [LEAF_1]: 'pty-agent',
          [LEAF_2]: 'pty-agent'
        }
      },
      true
    )

    expect(manager.createInitialPane).toHaveBeenCalledWith({ focus: true, leafId: LEAF_3 })
    expect(manager.splitPane).not.toHaveBeenCalled()
    expect([...restored]).toEqual([[LEAF_3, 1]])
  })

  it('reattaches one PTY when the split repeats its bound leaf id', () => {
    const manager = {
      createInitialPane: vi.fn((opts?: { leafId?: string }) => ({
        id: 1,
        leafId: opts?.leafId ?? LEAF_2
      })),
      splitPane: vi.fn()
    }

    const restored = replayTerminalLayout(
      manager as unknown as Parameters<typeof replayTerminalLayout>[0],
      {
        root: {
          type: 'split',
          direction: 'vertical',
          first: { type: 'leaf', leafId: LEAF_1 },
          second: { type: 'leaf', leafId: LEAF_1 }
        },
        activeLeafId: LEAF_1,
        expandedLeafId: null,
        ptyIdsByLeafId: { [LEAF_1]: 'pty-agent' }
      },
      true
    )

    expect(manager.createInitialPane).toHaveBeenCalledWith({ focus: true, leafId: LEAF_1 })
    expect(manager.splitPane).not.toHaveBeenCalled()
    expect([...restored]).toEqual([[LEAF_1, 1]])
  })
})
