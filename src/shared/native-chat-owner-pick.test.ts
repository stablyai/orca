import { describe, expect, it } from 'vitest'
import { ownerlessChatDisplayLeaf, pickChatOwnerLeaf } from './native-chat-owner-pick'

describe('ownerlessChatDisplayLeaf (R1-F1)', () => {
  const canShow = (leaves: string[]) => (leafId: string) => leaves.includes(leafId)
  const settledOn = (leafId: string) => ({ leafId, settled: true })

  it('takes the sole or active leaf only when that leaf can show chat now', () => {
    const at = (args: Partial<Parameters<typeof ownerlessChatDisplayLeaf>[0]>) =>
      ownerlessChatDisplayLeaf({
        shown: null,
        leafIds: ['A', 'B'],
        activeLeafId: 'B',
        canShowChat: canShow(['A', 'B']),
        ...args
      })
    expect(at({ leafIds: ['A'], activeLeafId: null })).toEqual(settledOn('A'))
    expect(at({})).toEqual(settledOn('B'))
    expect(at({ canShowChat: canShow(['A']) })).toBeNull()
    expect(at({ activeLeafId: null })).toBeNull()
    expect(at({ activeLeafId: 'gone' })).toBeNull()
    // R2a-F2: a gated agent waiting on readability holds the leaf, unsettled.
    expect(at({ canShowChat: () => 'unknown' })).toEqual({ leafId: 'B', settled: false })
  })

  it('stays on the leaf it shows while that leaf exists, whatever is active or eligible now', () => {
    const shownOnA = { shown: 'A', activeLeafId: 'B', canShowChat: canShow([]) }
    expect(ownerlessChatDisplayLeaf({ ...shownOnA, leafIds: ['A', 'B'] })).toEqual(settledOn('A'))
    expect(ownerlessChatDisplayLeaf({ ...shownOnA, leafIds: ['B'] })).toBeNull()
  })
})

describe('pickChatOwnerLeaf (F1 host owner pick)', () => {
  const agents: Record<string, string> = { A: 'claude', C: 'codex', S: 'bash-not-an-agent' }
  const pick = (args: Partial<Parameters<typeof pickChatOwnerLeaf>[0]>) =>
    pickChatOwnerLeaf({
      leafIds: ['A', 'B'],
      activeLeafId: 'B',
      leafLaunchAgent: (leafId) => agents[leafId],
      ...args
    })

  it('gives a sole leaf the chat whatever it runs', () => {
    expect(pick({ leafIds: ['B'], activeLeafId: null })).toBe('B')
  })

  it('takes the active leaf only when its process was launched as a supported agent', () => {
    expect(pick({ leafIds: ['A', 'C'], activeLeafId: 'C' })).toBe('C')
    expect(pick({ leafIds: ['A', 'C'], activeLeafId: 'A' })).toBe('A')
  })

  it('takes the first agent leaf in tree order when the active leaf is a shell', () => {
    expect(pick({ leafIds: ['B', 'C', 'A'], activeLeafId: 'B' })).toBe('C')
    expect(pick({})).toBe('A')
  })

  it('ignores an active leaf outside the tree and picks nothing when no leaf runs an agent', () => {
    expect(pick({ leafIds: ['B', 'A'], activeLeafId: 'gone' })).toBe('A')
    expect(pick({ leafIds: ['B', 'S'], activeLeafId: 'B' })).toBeNull()
    expect(pick({ leafIds: [] })).toBeNull()
  })
})
