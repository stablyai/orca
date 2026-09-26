import { describe, expect, it } from 'vitest'
import type { ConversationKnowledgeItem } from '../../../shared/conversation-knowledge-items'
import {
  buildConversationKnowledgeLaunchPrompt,
  getConversationKnowledgeLaunchItems,
  replaceConversationKnowledgeLaunchItems
} from './conversation-knowledge-launch-context'

const item: ConversationKnowledgeItem = {
  id: 'knowledge-1',
  source: {
    executionHostId: 'local',
    agent: 'codex',
    sessionId: 'session-1',
    title: 'Knowledge handoff',
    cwd: '/repo/worktree',
    updatedAt: '2026-09-16T00:00:00.000Z'
  },
  knowledge: {
    summary: 'Summary',
    topics: [],
    conclusions: [],
    entities: [],
    handoff: [
      {
        kind: 'constraint',
        text: 'Keep the knowledge source local to the execution host.',
        reliability: 'user-confirmed',
        evidence: { kind: 'conversation', messageId: 'user-1' }
      }
    ]
  },
  generator: { agent: 'codex', model: 'gpt-5.6-sol', generatedAt: '2026-09-16T00:00:00.000Z' }
}

describe('buildConversationKnowledgeLaunchPrompt', () => {
  it('keeps only the last successfully loaded launch context', () => {
    replaceConversationKnowledgeLaunchItems([item])
    expect(getConversationKnowledgeLaunchItems()).toEqual([item])
    replaceConversationKnowledgeLaunchItems([])
    expect(getConversationKnowledgeLaunchItems()).toEqual([])
  })

  it('prefixes a task with same-host, same-worktree confirmed context', () => {
    expect(
      buildConversationKnowledgeLaunchPrompt({
        prompt: 'Implement the next change.',
        cwd: '/repo/worktree',
        executionHostId: 'local',
        items: [item]
      })
    ).toContain('Keep the knowledge source local to the execution host.')
  })

  it('does not turn an empty launch into an unsolicited agent request', () => {
    expect(
      buildConversationKnowledgeLaunchPrompt({
        prompt: '  ',
        cwd: '/repo/worktree',
        executionHostId: 'local',
        items: [item]
      })
    ).toBe('')
  })

  it('does not cross execution-host boundaries', () => {
    expect(
      buildConversationKnowledgeLaunchPrompt({
        prompt: 'Implement the next change.',
        cwd: '/repo/worktree',
        executionHostId: 'ssh:host-a',
        items: [item]
      })
    ).toBe('Implement the next change.')
  })
})
