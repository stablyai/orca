// @vitest-environment happy-dom

import { cleanup, renderHook } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import { localizedHostedReviewCopy } from '@/i18n/hosted-review-localized-copy'
import { makeRepo, makeWorktree } from '../../../worktree-jump-palette-test-fixtures'
import { getDefaultSettings } from '../../../../../../shared/constants'
import {
  getDefaultSourceControlAiSettings,
  DEFAULT_SOURCE_CONTROL_AI_PR_CREATION_DEFAULTS
} from '../../../../../../shared/source-control-ai-settings'
import type { HostedReviewCreationEligibility } from '../../../../../../shared/hosted-review'
import { useSourceControlCreatePrIntentReview } from './use-create-pr-intent-review'

const runtime = vi.hoisted(() => ({ generate: vi.fn() }))
vi.mock('@/runtime/runtime-git-generation-client', () => ({
  generateRuntimePullRequestFields: runtime.generate
}))
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  runtime.generate.mockReset()
})

it.each(['github', 'gitlab'] as const)(
  'prefixes unattended %s review creation before and after generation',
  async (provider) => {
    const workspace = makeWorktree('wt-1', 'Jira task', {
      linkedWorkItem: {
        provider: 'jira',
        type: 'issue',
        number: 0,
        title: 'Fix login',
        jiraIdentifier: 'ALT-42',
        url: 'https://jira.example.com/browse/alt-42'
      }
    })
    const lookup = vi
      .spyOn(useAppStore.getState(), 'getKnownWorktreeById')
      .mockReturnValue(workspace)
    const token = {
      repoId: 'repo-1',
      worktreeId: 'wt-1',
      worktreePath: '/repo/wt',
      branch: 'user/alt-42-fix-login',
      provider,
      baseRef: null,
      startedAt: 1
    }
    const eligibility: HostedReviewCreationEligibility = {
      provider,
      review: null,
      canCreate: true,
      blockedReason: null,
      nextAction: null,
      reviewLookupOutcome: 'not_found',
      defaultBaseRef: 'main',
      title: 'Fix login',
      body: 'Details'
    }
    const create = vi
      .fn()
      .mockResolvedValue({ ok: true, number: 100, url: 'https://example.com/reviews/100' })
    const settings = {
      ...getDefaultSettings('/fixture'),
      sourceControlAi: { ...getDefaultSourceControlAiSettings(), agentId: 'cursor' as const }
    }
    const { result, rerender } = renderHook<
      {
        createHostedReviewForCreatePrIntent: ReturnType<
          typeof useSourceControlCreatePrIntentReview
        >['createHostedReviewForCreatePrIntent']
      },
      { settings: typeof settings | null }
    >(
      ({ settings }) =>
        useSourceControlCreatePrIntentReview({
          activeRepo: { ...makeRepo(), connectionId: 'owner' },
          createHostedReview: create,
          createPrInFlightRef: { current: {} },
          createPrIntentActiveTargetConflicts: () => false,
          createPrIntentCurrentTargetRef: { current: token },
          createPrIntentRunStillOwnsWorktree: () => true,
          getCreatePrIntentOperationTarget: () => ({
            target: { kind: 'local' },
            worktreeId: 'wt-1',
            worktreePath: '/repo/wt'
          }),
          handlePullRequestCreated: vi.fn(),
          hostedReviewCreateCopy: localizedHostedReviewCopy(provider),
          prBase: 'main',
          prBody: '',
          resolvedPrCreationDefaults: DEFAULT_SOURCE_CONTROL_AI_PR_CREATION_DEFAULTS,
          setCreatePrInFlightByWorktree: vi.fn(),
          setCreatePrIntentNoticeForWorktree: vi.fn(),
          settings
        }),
      { initialProps: { settings: null } }
    )
    await expect(
      result.current.createHostedReviewForCreatePrIntent(token, eligibility)
    ).resolves.toBe(true)
    expect(create).toHaveBeenLastCalledWith(
      expect.any(String),
      expect.objectContaining({ title: 'ALT-42 Fix login' })
    )
    expect(lookup).toHaveBeenCalledWith('wt-1', 'ssh:owner')
    runtime.generate.mockResolvedValue({
      success: true,
      fields: { base: 'main', title: 'alt-42 ALT-42 Better login', body: 'Generated', draft: false }
    })
    rerender({ settings })
    await expect(
      result.current.createHostedReviewForCreatePrIntent(token, eligibility)
    ).resolves.toBe(true)
    expect(runtime.generate).toHaveBeenCalled()
    expect(create).toHaveBeenLastCalledWith(
      expect.any(String),
      expect.objectContaining({ title: 'ALT-42 Better login' })
    )
  }
)
