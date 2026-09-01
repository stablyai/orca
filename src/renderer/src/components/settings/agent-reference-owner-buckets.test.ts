import { describe, expect, it } from 'vitest'
import type {
  AgentReferenceOwnerKind,
  AgentReferenceSummary
} from '../../../../shared/agent-reference-snapshot'
import { classifyReferenceOwner, groupReferencesByBucket } from './agent-reference-owner-buckets'

describe('classifyReferenceOwner', () => {
  it('places editor-backed owners in the rebindable bucket', () => {
    const rebindable: AgentReferenceOwnerKind[] = [
      'default',
      'quick-command',
      'commit-message',
      'source-control-recipe',
      'automation'
    ]
    for (const owner of rebindable) {
      expect(classifyReferenceOwner(owner)).toBe('rebindable')
    }
  })

  it('places terminal sessions in the removable-record bucket', () => {
    expect(classifyReferenceOwner('session')).toBe('removable')
  })

  it('places lifecycle-bound owners in the retained bucket', () => {
    for (const owner of ['background', 'orchestration', 'workspace'] as const) {
      expect(classifyReferenceOwner(owner)).toBe('retained')
    }
  })
})

describe('groupReferencesByBucket', () => {
  it('groups owners into ordered buckets and sums readable counts', () => {
    const summary: AgentReferenceSummary[] = [
      { owner: 'workspace', count: 1 },
      { owner: 'quick-command', count: 2 },
      { owner: 'default', count: 1 },
      { owner: 'session', count: 3 }
    ]
    const groups = groupReferencesByBucket(summary)
    expect(groups.map((g) => g.bucket)).toEqual(['rebindable', 'removable', 'retained'])
    // Rebindable keeps the canonical owner order regardless of input order.
    expect(groups[0].owners.map((o) => o.owner)).toEqual(['default', 'quick-command'])
    expect(groups[0].total).toBe(3)
    expect(groups[1].total).toBe(3)
    expect(groups[2].total).toBe(1)
  })

  it('drops zero-count owners and omits empty buckets', () => {
    const groups = groupReferencesByBucket([
      { owner: 'automation', count: 0 },
      { owner: 'quick-command', count: 1 }
    ])
    expect(groups).toHaveLength(1)
    expect(groups[0].owners.map((o) => o.owner)).toEqual(['quick-command'])
  })

  it('surfaces an unreadable owner store without counting it in the total', () => {
    const groups = groupReferencesByBucket([
      { owner: 'automation', count: -1 },
      { owner: 'quick-command', count: 2 }
    ])
    const rebindable = groups[0]
    expect(rebindable.total).toBe(2)
    expect(rebindable.unreadable).toBe(true)
    const automation = rebindable.owners.find((o) => o.owner === 'automation')
    expect(automation).toEqual({ owner: 'automation', count: 0, unreadable: true })
  })
})
