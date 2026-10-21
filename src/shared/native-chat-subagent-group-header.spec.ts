import { describe, expect, it } from 'vitest'
import {
  formatSubagentTokens,
  nativeChatSubagentGroupHeader,
  sayNativeChatSubagentGroupEnglish as say
} from './native-chat-subagent-group-header'
import type { NativeChatSubagentEntry, NativeChatSubagentState } from './native-chat-types'

function child(
  id: string,
  state: NativeChatSubagentState,
  extra: Partial<NativeChatSubagentEntry> = {}
): NativeChatSubagentEntry {
  return { id, label: id, state, ...extra }
}

describe('nativeChatSubagentGroupHeader', () => {
  it('counts working children while the group runs', () => {
    const header = nativeChatSubagentGroupHeader(
      [child('a', 'working', { startedAt: 1_000 }), child('b', 'working', { startedAt: 2_000 })],
      say
    )
    expect(header).toMatchObject({
      working: true,
      headline: 'Kicked off 2 subagents',
      verdictState: 'working',
      verdict: '2 working',
      alert: null,
      clockStartedAt: 1_000,
      tokens: null
    })
  })

  it('reports a failed sibling before the rest settle', () => {
    const header = nativeChatSubagentGroupHeader(
      [child('a', 'working'), child('b', 'failed', { settledAt: 5 })],
      say
    )
    expect(header).toMatchObject({ alertState: 'failed', alert: '1 failed' })
  })

  it('settles to the worst verdict, the run length and the tokens', () => {
    const header = nativeChatSubagentGroupHeader(
      [
        child('a', 'completed', { startedAt: 0, settledAt: 60_000, tokens: 9_000 }),
        child('b', 'completed', { startedAt: 0, settledAt: 62_000, tokens: 3_000 })
      ],
      say
    )
    expect(header).toMatchObject({
      working: false,
      headline: 'Ran 2 subagents',
      verdict: 'completed',
      clockStartedAt: 0,
      settledAt: 62_000,
      tokens: '12k tokens'
    })
  })

  it('stops the clock when a settled child has no stamp', () => {
    const header = nativeChatSubagentGroupHeader(
      [child('a', 'unverifiable', { startedAt: 0 })],
      say
    )
    expect(header).toMatchObject({ verdict: 'status unavailable', clockStartedAt: null })
  })

  it('reads a single child as a bare word', () => {
    expect(nativeChatSubagentGroupHeader([child('a', 'working')], say)).toMatchObject({
      headline: 'Kicked off 1 subagent',
      verdict: 'working'
    })
  })
})

describe('formatSubagentTokens', () => {
  it('shows scale', () => {
    expect(formatSubagentTokens(950)).toBe('950')
    expect(formatSubagentTokens(12_340)).toBe('12.3k')
    expect(formatSubagentTokens(2_000_000)).toBe('2M')
  })
})
