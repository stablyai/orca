import { describe, expect, it } from 'vitest'
import { measureTerminalScrollbackBuffers } from './terminal-scrollback-memory-census'
import type { TerminalLayoutSnapshot } from '../../../shared/types'

function layout(buffersByLeafId?: Record<string, string>): TerminalLayoutSnapshot {
  return { root: null, activeLeafId: null, expandedLeafId: null, buffersByLeafId }
}

describe('measureTerminalScrollbackBuffers', () => {
  it('sums leaf buffer characters across tabs, not just tab count', () => {
    const census = measureTerminalScrollbackBuffers({
      terminalLayoutsByTabId: {
        tab1: layout({ leafA: 'x'.repeat(1000), leafB: 'y'.repeat(500) }),
        tab2: layout({ leafC: 'z'.repeat(250) })
      },
      pendingColdRestoreByPtyId: {}
    })
    expect(census).toEqual({
      layouts: 2,
      buffers: 3,
      chars: 1750,
      coldRestores: 0,
      coldRestoreChars: 0
    })
  })

  it('separates the size signal from the count the store profile already reports', () => {
    const many = Object.fromEntries(
      Array.from({ length: 170 }, (_, i) => [`tab${i}`, layout({ leaf: 'a'.repeat(1024) })])
    )
    const few = { tab0: layout({ leaf: 'a'.repeat(512 * 1024) }) }
    // The whole point: 170 tabs can hold far less than 1 tab does.
    expect(
      measureTerminalScrollbackBuffers({
        terminalLayoutsByTabId: many,
        pendingColdRestoreByPtyId: {}
      }).chars
    ).toBeLessThan(
      measureTerminalScrollbackBuffers({
        terminalLayoutsByTabId: few,
        pendingColdRestoreByPtyId: {}
      }).chars
    )
  })

  it('counts pending cold-restore scrollback separately from layout buffers', () => {
    const census = measureTerminalScrollbackBuffers({
      terminalLayoutsByTabId: { tab1: layout({ leafA: 'x'.repeat(10) }) },
      pendingColdRestoreByPtyId: {
        pty1: { scrollback: 'q'.repeat(2048), cwd: '/repo' },
        pty2: { scrollback: '', cwd: '/repo' }
      }
    })
    expect(census.chars).toBe(10)
    expect(census.coldRestores).toBe(2)
    expect(census.coldRestoreChars).toBe(2048)
  })

  it('reports zeros rather than omitting fields when nothing is held', () => {
    expect(
      measureTerminalScrollbackBuffers({
        terminalLayoutsByTabId: {},
        pendingColdRestoreByPtyId: {}
      })
    ).toEqual({ layouts: 0, buffers: 0, chars: 0, coldRestores: 0, coldRestoreChars: 0 })
  })

  it('tolerates layouts with no captured buffers', () => {
    const census = measureTerminalScrollbackBuffers({
      terminalLayoutsByTabId: { tab1: layout(), tab2: layout({}) },
      pendingColdRestoreByPtyId: {}
    })
    expect(census).toMatchObject({ layouts: 2, buffers: 0, chars: 0 })
  })
})
