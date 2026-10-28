import { describe, expect, it } from 'vitest'
import {
  nativeChatWorkRunSpans,
  type NativeChatWorkRunMember,
  type NativeChatWorkRunRow
} from './native-chat-work-run'

/** `t` thought, `c` call, `l` lead, `x` a drawn row that ends runs, `-` a row that draws nothing;
 *  `|` starts the next scope. */
function rowsOf(pattern: string): NativeChatWorkRunRow[] {
  const members: Record<string, NativeChatWorkRunMember> = { t: 'thought', c: 'tool', l: 'lead' }
  let scope = 0
  return [...pattern].flatMap((char) => {
    if (char === '|') {
      scope += 1
      return []
    }
    return [{ member: members[char] ?? null, draws: char !== '-', scope: String(scope) }]
  })
}

const spans = (pattern: string): number[][] => nativeChatWorkRunSpans(rowsOf(pattern))

describe('work run spans', () => {
  it('runs thoughts and calls together until something else draws', () => {
    expect(spans('tctctxct')).toEqual([
      [0, 1, 2, 3, 4],
      [6, 7]
    ])
  })

  it('needs two members and a call', () => {
    expect(spans('c')).toEqual([])
    expect(spans('tt')).toEqual([])
    expect(spans('txc')).toEqual([])
  })

  it('lets a lead head a run but never join one', () => {
    expect(spans('ltclt')).toEqual([
      [0, 1, 2],
      [3, 4]
    ])
    expect(spans('cl')).toEqual([])
  })

  it('stays open across a row that draws nothing', () => {
    expect(spans('c-t-c')).toEqual([[0, 2, 4]])
  })

  it('never crosses a scope, even through a row that draws nothing', () => {
    expect(spans('ct|c')).toEqual([[0, 1]])
    expect(spans('c|-|c')).toEqual([])
  })
})
