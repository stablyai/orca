import { expect, it, vi } from 'vitest'
import { createAgentCompletionTitleObserver } from './agent-completion-title-observer'

it('keeps a leading Kimchi title as the owner when its task names another agent', () => {
  const observer = createAgentCompletionTitleObserver({
    getLastStatus: () => null,
    setLastStatus: vi.fn(),
    hasAgentEvidence: () => false,
    establishAgentEvidence: vi.fn(),
    recordPaneActivity: vi.fn(),
    recordTitleWorking: () => false,
    holdTitleCompletionPending: vi.fn(),
    hasPendingTitle: () => false,
    dropPendingTitle: vi.fn(),
    claimTitleCompletion: () => false,
    dispatchTitleCompletion: vi.fn()
  })

  expect(observer.titleCompletionAgentIdentity('Kimchi - fix codex integration')).toBe('kimchi')
  expect(observer.titleCompletionAgentIdentity('⠋ Kimchi - review Claude output')).toBe('kimchi')
})
