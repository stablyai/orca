import { describe, expect, it } from 'vitest'
import {
  parseApprovalFromStatus,
  resolveNativeChatInteractivePromptCard
} from './native-chat-interactive-prompt'
import type { NativeChatMessage } from './native-chat-types'
import { buildOmpPlanReviewAnswer } from './omp-plan-review-prompt'

describe('parseApprovalFromStatus', () => {
  it('returns null for non-approval envelopes', () => {
    expect(parseApprovalFromStatus(null)).toBeNull()
    expect(parseApprovalFromStatus('not json')).toBeNull()
    expect(parseApprovalFromStatus('{}')).toBeNull()
    expect(parseApprovalFromStatus(JSON.stringify({ approval: {} }))).toBeNull()
    expect(parseApprovalFromStatus(JSON.stringify({ approval: { tool: '' } }))).toBeNull()
  })

  it('reads the OMP plan review envelope', () => {
    const planReview = JSON.stringify({
      planReview: {
        reviewId: 'review-1',
        plan: '# Plan',
        options: [{ id: 'execute', label: 'Approve and execute' }]
      }
    })
    expect(parseApprovalFromStatus(planReview, 'omp')).toMatchObject({
      title: 'Review proposed plan',
      subject: { kind: 'plan', text: '# Plan' },
      options: [
        { label: 'Approve and execute', send: buildOmpPlanReviewAnswer('review-1', 'execute') }
      ]
    })
  })
})

describe('resolveNativeChatInteractivePromptCard', () => {
  const pendingAsk: NativeChatMessage = {
    id: 'm1',
    role: 'assistant',
    blocks: [
      {
        type: 'tool-call',
        name: 'AskUserQuestion',
        input: { questions: [{ question: 'Which path?', options: ['fast', 'safe'] }] }
      }
    ],
    timestamp: 0,
    source: 'transcript'
  }

  it('lets a live approval win over a pending transcript ask', () => {
    const resolve = (interactivePrompt: string | null) =>
      resolveNativeChatInteractivePromptCard({
        interactivePrompt,
        messages: [pendingAsk],
        transcriptSettled: true
      })
    expect(resolve(JSON.stringify({ approval: { tool: 'Bash' } }))?.kind).toBe('approval')
    expect(resolve(null)?.kind).toBe('question')
  })
})
