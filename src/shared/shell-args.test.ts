import { describe, expect, it } from 'vitest'
import { parseShellArgs } from './shell-args'

describe('parseShellArgs', () => {
  it('keeps a quoted empty string as its own argument', () => {
    expect(parseShellArgs('storage local set key ""')).toEqual([
      'storage',
      'local',
      'set',
      'key',
      ''
    ])
    expect(parseShellArgs("fill @e1 '' next")).toEqual(['fill', '@e1', '', 'next'])
  })

  it('does not make empty words from repeated spaces or quotes next to text', () => {
    expect(parseShellArgs('a  ""x  b')).toEqual(['a', 'x', 'b'])
  })
})
