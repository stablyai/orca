import { describe, expect, it } from 'vitest'
import { parseTerminalOscColorQuery } from './terminal-osc-color-reply'

describe('parseTerminalOscColorQuery', () => {
  it('matches exact OSC color queries terminated by ST or BEL', () => {
    const foregroundQuery = '\x1b]10;?\x1b\\'
    const backgroundQuery = '\x1b]11;?\x07'

    expect(parseTerminalOscColorQuery(foregroundQuery, 0)).toEqual({
      kind: 'match',
      slots: [10],
      endIndex: foregroundQuery.length
    })
    expect(parseTerminalOscColorQuery(backgroundQuery, 0)).toEqual({
      kind: 'match',
      slots: [11],
      endIndex: backgroundQuery.length
    })
  })

  it('matches complete combined foreground and background queries', () => {
    const query = '\x1b]10;?;?\x1b\\'

    expect(parseTerminalOscColorQuery(query, 0)).toEqual({
      kind: 'match',
      slots: [10, 11],
      endIndex: query.length
    })
  })

  it('keeps a split ST terminator pending', () => {
    expect(parseTerminalOscColorQuery('\x1b]10;?\x1b', 0)).toEqual({ kind: 'partial' })
    expect(parseTerminalOscColorQuery('\x1b]10;?;?\x1b', 0)).toEqual({ kind: 'partial' })
  })

  it('rejects OSC color commands that only start like queries', () => {
    expect(parseTerminalOscColorQuery('\x1b]10;?not-a-query\x1b\\', 0)).toEqual({
      kind: 'none'
    })
    expect(parseTerminalOscColorQuery('\x1b]11;?\x1bX', 0)).toEqual({ kind: 'none' })
    expect(parseTerminalOscColorQuery('\x1b]10;?;#123456\x1b\\', 0)).toEqual({ kind: 'none' })
    expect(parseTerminalOscColorQuery('\x1b]10;?;?;?\x1b\\', 0)).toEqual({ kind: 'none' })
    expect(parseTerminalOscColorQuery('\x1b]11;?;?\x1b\\', 0)).toEqual({ kind: 'none' })
  })

  it('rejects unsupported query-shaped bodies without waiting for a terminator', () => {
    expect(parseTerminalOscColorQuery(`\x1b]10;?${'x'.repeat(10_000)}`, 0)).toEqual({
      kind: 'none'
    })
  })
})
