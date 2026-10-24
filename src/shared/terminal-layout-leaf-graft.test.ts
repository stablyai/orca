import { describe, expect, it } from 'vitest'
import { graftLeafBeside } from './terminal-layout-leaf-graft'
import type { TerminalLayoutSnapshot } from './terminal-tab-types'

const A = '22222222-2222-4222-8222-222222222222'
const B = '11111111-1111-4111-8111-111111111111'
const C = '33333333-3333-4333-8333-333333333333'

const source: TerminalLayoutSnapshot = {
  root: { type: 'leaf', leafId: A },
  activeLeafId: A,
  expandedLeafId: null,
  ptyIdsByLeafId: { [A]: 'pty-stale' },
  titlesByLeafId: { [A]: 'agent' },
  buffersByLeafId: { [A]: 'buffer-a' },
  scrollbackRefsByLeafId: { [A]: 'ref-a' }
}

function target(): TerminalLayoutSnapshot {
  return {
    root: {
      type: 'split',
      direction: 'vertical',
      first: { type: 'leaf', leafId: B },
      second: { type: 'leaf', leafId: C }
    },
    activeLeafId: C,
    expandedLeafId: B,
    chatLeafId: C,
    ptyIdsByLeafId: { [B]: 'pty-b', [C]: 'pty-c' },
    titlesByLeafId: { [B]: 'b title' },
    buffersByLeafId: { [B]: 'buffer-b' }
  }
}

const args = { source, leafId: A, targetLeafId: B, ptyId: 'pty-a' }

describe('graftLeafBeside', () => {
  it('puts the leaf beside the target leaf and makes it the active, uncollapsed pane', () => {
    const grafted = graftLeafBeside({ ...args, target: target(), side: 'right' })

    expect(grafted?.root).toEqual({
      type: 'split',
      direction: 'vertical',
      first: {
        type: 'split',
        direction: 'vertical',
        first: { type: 'leaf', leafId: B },
        second: { type: 'leaf', leafId: A }
      },
      second: { type: 'leaf', leafId: C }
    })
    expect(grafted).toMatchObject({ activeLeafId: A, expandedLeafId: null, chatLeafId: C })
  })

  it.each([
    ['left', 'vertical', A, B],
    ['right', 'vertical', B, A],
    ['top', 'horizontal', A, B],
    ['bottom', 'horizontal', B, A]
  ] as const)('places %s of the target as a %s split', (side, direction, first, second) => {
    const grafted = graftLeafBeside({ ...args, target: target(), side })
    const inner = grafted?.root?.type === 'split' ? grafted.root.first : null

    expect(inner).toEqual({
      type: 'split',
      direction,
      first: { type: 'leaf', leafId: first },
      second: { type: 'leaf', leafId: second }
    })
  })

  it('carries the live PTY id, title, buffer and scrollback ref and keeps the target records', () => {
    const grafted = graftLeafBeside({ ...args, target: target(), side: 'right' })

    expect(grafted?.ptyIdsByLeafId).toEqual({ [A]: 'pty-a', [B]: 'pty-b', [C]: 'pty-c' })
    expect(grafted?.titlesByLeafId).toEqual({ [A]: 'agent', [B]: 'b title' })
    expect(grafted?.buffersByLeafId).toEqual({ [A]: 'buffer-a', [B]: 'buffer-b' })
    expect(grafted?.scrollbackRefsByLeafId).toEqual({ [A]: 'ref-a' })
  })

  it('carries no binding when the move names no PTY', () => {
    const grafted = graftLeafBeside({ ...args, ptyId: null, target: target(), side: 'right' })

    expect(grafted?.ptyIdsByLeafId).toEqual({ [B]: 'pty-b', [C]: 'pty-c' })
  })

  it('refuses a target leaf the target layout lacks and a leaf it already holds', () => {
    expect(
      graftLeafBeside({ ...args, target: target(), targetLeafId: A, side: 'right' })
    ).toBeNull()
    expect(graftLeafBeside({ ...args, target: target(), leafId: C, side: 'right' })).toBeNull()
  })

  it('does not mutate the layouts it reads', () => {
    const before = structuredClone(target())
    const input = target()
    graftLeafBeside({ ...args, target: input, side: 'bottom' })

    expect(input).toEqual(before)
    expect(source.ptyIdsByLeafId).toEqual({ [A]: 'pty-stale' })
  })

  it('titles the leaf with the fallback only when the source records no title', () => {
    const untitled = { ...source, titlesByLeafId: {} }
    const fallback = graftLeafBeside({
      ...args,
      source: untitled,
      target: target(),
      side: 'right',
      fallbackTitle: 'My build'
    })
    expect(fallback?.titlesByLeafId).toEqual({ [B]: 'b title', [A]: 'My build' })

    const own = graftLeafBeside({ ...args, target: target(), side: 'right', fallbackTitle: 'x' })
    expect(own?.titlesByLeafId?.[A]).toBe('agent')
  })
})
