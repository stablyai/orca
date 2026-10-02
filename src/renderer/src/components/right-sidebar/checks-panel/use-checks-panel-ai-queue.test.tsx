// @vitest-environment happy-dom

import { cleanup, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { PRInfo } from '../../../../../shared/github/pull-request-types'
import type { ChecksPanelReview } from '../checks-panel-review'
import { useChecksPanelAiQueue } from './use-checks-panel-ai-queue'

type AiQueueInput = Parameters<typeof useChecksPanelAiQueue>[0]

afterEach(cleanup)

const conflictingReview: ChecksPanelReview = {
  provider: 'github',
  number: 42,
  state: 'open',
  title: 'Conflicting PR',
  url: 'https://github.com/acme/widgets/pull/42',
  status: 'pending',
  updatedAt: '2026-09-30T00:00:00Z',
  mergeable: 'CONFLICTING'
}

const conflictingPR: PRInfo = {
  number: 42,
  title: 'Conflicting PR',
  state: 'open',
  url: 'https://github.com/acme/widgets/pull/42',
  checksStatus: 'pending',
  updatedAt: '2026-09-30T00:00:00Z',
  mergeable: 'CONFLICTING',
  baseRefName: 'main',
  prRepo: { owner: 'acme', repo: 'widgets', host: 'github.com' }
}

function makeInput(overrides: Partial<AiQueueInput> = {}): AiQueueInput {
  return {
    activeConflictReview: conflictingReview,
    activeReview: conflictingReview,
    activeWorktreeId: 'worktree-1',
    activeWorktreePath: '/repo/worktree',
    claimedCommentResolutionRef: { current: null },
    commentResolutionAckBusyRef: { current: false },
    commentResolutionLaunchAcceptedRef: { current: false },
    pendingCommentResolutionRef: { current: null },
    pr: conflictingPR,
    prNumber: 42,
    repo: null,
    resolveCommentsWithAIDisabledReason: undefined,
    setAgentComposerState: vi.fn(),
    sourceControlAiActionsVisible: true,
    stateRequestKey: 'review-42',
    ...overrides
  }
}

function launchedPrompt(input: AiQueueInput): string {
  const { result } = renderHook(() => useChecksPanelAiQueue(input))
  void result.current.handleResolveConflictsWithAI()
  const state: unknown = vi.mocked(input.setAgentComposerState).mock.calls[0]?.[0]
  return state && typeof state === 'object' && 'prompt' in state && typeof state.prompt === 'string'
    ? state.prompt
    : ''
}

describe('useChecksPanelAiQueue resolve conflicts', () => {
  it("names the GitHub PR's base branch and repository from the PR", () => {
    const prompt = launchedPrompt(makeInput())

    expect(prompt).toContain('- PR base: branch "main" of repository "acme/widgets"')
    expect(prompt).toContain('Find the remote whose URL points at "acme/widgets"')
  })

  it('keeps GitLab on the hosting remote without a base name', () => {
    const gitLabReview: ChecksPanelReview = { ...conflictingReview, provider: 'gitlab' }
    const prompt = launchedPrompt(
      makeInput({ activeConflictReview: gitLabReview, activeReview: gitLabReview })
    )

    expect(prompt).toContain('- MR base branch: unavailable')
    expect(prompt).not.toContain('acme/widgets')
  })
})
