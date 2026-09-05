import { describe, expect, it } from 'vitest'
import {
  normalizeWorkspaceMultiplexerState,
  remapWorkspaceMultiplexerWorktreeId
} from './workspace-multiplexer-types'

describe('normalizeWorkspaceMultiplexerState', () => {
  it('rebuilds a complete layout when a persisted branch is invalid', () => {
    expect(
      normalizeWorkspaceMultiplexerState({
        slots: [
          {
            id: 'slot-a',
            worktreeId: 'worktree-a',
            executionHostId: 'ssh:devbox',
            groupId: 'group-a',
            activeTerminalTabId: 'terminal-a'
          },
          {
            id: 'slot-b',
            worktreeId: 'worktree-b',
            groupId: null,
            activeTerminalTabId: null
          }
        ],
        layout: {
          type: 'split',
          direction: 'vertical',
          first: { type: 'leaf', groupId: 'slot-a' },
          second: { type: 'leaf', groupId: 'missing-slot' },
          ratio: 0.7
        }
      })
    ).toEqual({
      slots: [
        {
          id: 'slot-a',
          worktreeId: 'worktree-a',
          executionHostId: 'ssh:devbox',
          groupId: 'group-a',
          activeTerminalTabId: 'terminal-a'
        },
        {
          id: 'slot-b',
          worktreeId: 'worktree-b',
          groupId: null,
          activeTerminalTabId: null
        }
      ],
      panes: [
        { id: 'slot-a', activeSlotId: 'slot-a', slotOrder: ['slot-a'] },
        { id: 'slot-b', activeSlotId: 'slot-b', slotOrder: ['slot-b'] }
      ],
      layout: {
        type: 'split',
        direction: 'horizontal',
        first: { type: 'leaf', groupId: 'slot-a' },
        second: { type: 'leaf', groupId: 'slot-b' },
        ratio: 0.5
      }
    })
  })

  it('bounds malformed pane tab orders before reading them', () => {
    const slotOrder = Array.from({ length: 25 }, () => 'slot-a')
    Object.defineProperty(slotOrder, 24, {
      get: () => {
        throw new Error('read beyond persisted slot limit')
      }
    })

    const state = normalizeWorkspaceMultiplexerState({
      slots: [{ id: 'slot-a', worktreeId: 'worktree-a', groupId: null, activeTerminalTabId: null }],
      panes: [{ id: 'pane-a', activeSlotId: 'slot-a', slotOrder }]
    })

    expect(state.panes[0]?.slotOrder).toEqual(['slot-a'])
  })

  it('stops walking a persisted layout at its first invalid branch', () => {
    const layout = {
      type: 'split',
      direction: 'horizontal',
      first: { type: 'leaf', groupId: 'missing-slot' },
      ratio: 0.5
    }
    Object.defineProperty(layout, 'second', {
      enumerable: true,
      get: () => {
        throw new Error('read past the failing branch')
      }
    })

    const state = normalizeWorkspaceMultiplexerState({
      slots: [{ id: 'slot-a', worktreeId: 'worktree-a', groupId: null, activeTerminalTabId: null }],
      layout
    })

    expect(state.layout).toEqual({ type: 'leaf', groupId: 'slot-a' })
  })

  it('remaps only slots owned by the renamed execution host', () => {
    const state = normalizeWorkspaceMultiplexerState({
      slots: [
        {
          id: 'local-slot',
          worktreeId: 'old-id',
          groupId: null,
          activeTerminalTabId: null
        },
        {
          id: 'remote-slot',
          worktreeId: 'old-id',
          executionHostId: 'ssh:devbox',
          groupId: null,
          activeTerminalTabId: null
        }
      ]
    })

    const renamed = remapWorkspaceMultiplexerWorktreeId(state, 'old-id', 'new-id', 'ssh:devbox')

    expect(renamed?.slots.map(({ id, worktreeId }) => ({ id, worktreeId }))).toEqual([
      { id: 'local-slot', worktreeId: 'old-id' },
      { id: 'remote-slot', worktreeId: 'new-id' }
    ])
    expect(remapWorkspaceMultiplexerWorktreeId(state, 'missing', 'new-id')).toBe(state)
  })
})
