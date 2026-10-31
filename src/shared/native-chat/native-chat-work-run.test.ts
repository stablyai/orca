import { describe, expect, it } from 'vitest'
import {
  nativeChatWorkRunSpans,
  nativeChatWorkRunMember,
  nativeChatWorkRunEntries,
  type NativeChatWorkRunMember,
  type NativeChatWorkRunRow
} from './native-chat-work-run'
import { approvalReviewMessage } from '../native-chat-activity.test-fixture'

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

describe('successful automatic review activity', () => {
  it('joins only proven successful review notices to routine work', () => {
    const approved = approvalReviewMessage('approved')
    expect(nativeChatWorkRunMember(approved, false, false)).toBe('notice')
    expect(nativeChatWorkRunMember(approved, true, false)).toBeNull()
    for (const text of [
      'Automatic approval review rejected: not authorized.',
      'Automatic approval review denied: not authorized.',
      'Automatic approval review timed out.',
      'Automatic approval review approved (risk: low):',
      'Review required before continuing.',
      'Quoted: Automatic approval review approved (risk: low): allowed.'
    ]) {
      expect(nativeChatWorkRunMember(approvalReviewMessage('other', text), false, false)).toBeNull()
    }
  })

  it('retains review details in order around a tool call', () => {
    const before = approvalReviewMessage('before')
    const after = approvalReviewMessage('after')
    const call = {
      type: 'tool-call',
      name: 'Bash',
      input: { command: 'pnpm test' },
      state: 'completed'
    } as const
    const action = { ...before, id: 'action', role: 'assistant' as const, blocks: [call] }
    const entries = nativeChatWorkRunEntries([before, action, after])
    expect(entries.blocks).toEqual([call])
    expect([...entries.asidesBefore.values()].flat()).toContain(before)
    expect(entries.asidesAfter).toContain(after)
  })
})
