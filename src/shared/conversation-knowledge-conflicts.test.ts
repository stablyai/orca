import { describe, expect, it } from 'vitest'
import type { ConversationKnowledgeItem } from './conversation-knowledge-items'
import { reconcileConversationKnowledgeConflicts } from './conversation-knowledge-conflicts'
import { buildConversationKnowledgeContextPack } from './conversation-knowledge-items'

function item(
  sessionId: string,
  host: 'local' | `ssh:${string}`,
  cwd: string,
  object: string
): ConversationKnowledgeItem {
  return {
    id: `${host}:codex:${sessionId}`,
    source: {
      executionHostId: host,
      agent: 'codex',
      sessionId,
      title: sessionId,
      cwd,
      updatedAt: null
    },
    knowledge: {
      summary: '',
      topics: [],
      conclusions: [],
      entities: [],
      handoff: [
        {
          kind: 'decision',
          text: `Orca uses ${object}.`,
          reliability: 'user-confirmed',
          evidence: { kind: 'conversation', messageId: `user-${sessionId}` },
          claim: { subject: 'Orca', relation: 'summary-agent', object, cardinality: 'single' }
        }
      ]
    },
    generator: { agent: 'codex', model: 'gpt-5.6-sol', generatedAt: '2026-09-16T00:00:00Z' }
  }
}

describe('reconcileConversationKnowledgeConflicts', () => {
  it('marks different values for one single-valued relation conflicted on both sources', () => {
    const result = reconcileConversationKnowledgeConflicts([
      item('one', 'local', '/orca', 'Codex'),
      item('two', 'local', '/orca', 'Claude')
    ])
    expect(result.map((entry) => entry.knowledge.handoff?.[0]?.lifecycle?.status)).toEqual([
      'conflicted',
      'conflicted'
    ])
    expect(buildConversationKnowledgeContextPack({ items: result, cwd: '/orca' })).toBe('')
  })

  it('keeps matching values and different execution scopes active', () => {
    const result = reconcileConversationKnowledgeConflicts([
      item('one', 'local', '/orca', 'Codex'),
      item('two', 'local', '/orca', 'Codex'),
      item('three', 'ssh:remote', '/orca', 'Claude'),
      item('four', 'local', '/other', 'Claude')
    ])
    expect(
      result.every((entry) => entry.knowledge.handoff?.[0]?.lifecycle?.status !== 'conflicted')
    ).toBe(true)
  })

  it('does not override an explicitly retired claim', () => {
    const retired = item('one', 'local', '/orca', 'Codex')
    retired.knowledge.handoff![0].lifecycle = { status: 'superseded' }
    const result = reconcileConversationKnowledgeConflicts([
      retired,
      item('two', 'local', '/orca', 'Claude')
    ])
    expect(result[0].knowledge.handoff?.[0]?.lifecycle?.status).toBe('superseded')
    expect(result[1].knowledge.handoff?.[0]?.lifecycle?.status).not.toBe('conflicted')
  })

  it('clears an automatic conflict after the rival claim disappears', () => {
    const conflicted = reconcileConversationKnowledgeConflicts([
      item('one', 'local', '/orca', 'Codex'),
      item('two', 'local', '/orca', 'Claude')
    ])
    expect(
      reconcileConversationKnowledgeConflicts([conflicted[0]])[0].knowledge.handoff?.[0]?.lifecycle
        ?.status
    ).toBe('active')
  })
})
