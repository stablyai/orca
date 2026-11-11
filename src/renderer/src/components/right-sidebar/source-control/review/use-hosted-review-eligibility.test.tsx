// @vitest-environment happy-dom
import { memo } from 'react'
import { act, cleanup, render } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { HostedReviewProvider } from '../../../../../../shared/source-control/hosted-review/hosted-review-contracts'
import { useSourceControlHostedReviewEligibility } from './use-hosted-review-eligibility'

afterEach(cleanup)

const setRequestState = (): void => {}
const hint = {
  current: { repoId: null, worktreeId: null, branch: '', provider: 'github' as const }
}

const Host = memo(function Host({
  provider,
  getEligibility,
  setState
}: {
  provider: HostedReviewProvider
  getEligibility: () => Promise<never>
  setState: (state: unknown) => void
}): null {
  useSourceControlHostedReviewEligibility({
    activeRepoConnectionId: null,
    activeRepoExecutionHostId: null,
    activeRepoId: 'repo',
    activeRepoPath: '/repo',
    activeWorktreeId: 'wt',
    branchName: 'feature',
    effectiveBaseRef: 'origin/main',
    fallbackGitHubPRNumber: null,
    getHostedReviewCreationEligibility: getEligibility,
    hasUncommittedEntries: true,
    isBranchVisible: true,
    isCreatePrIntentInFlight: false,
    isCreatingPr: false,
    isFolder: false,
    linkedAzureDevOpsPR: null,
    linkedBitbucketPR: null,
    linkedGitHubPR: null,
    linkedGitLabMR: null,
    linkedGiteaPR: null,
    prGenerating: false,
    provisionalHostedReviewProvider: provider,
    remoteStatus: undefined,
    hostedReviewCreationProviderHintRef: hint,
    setHostedReviewCreationRequestState: setRequestState,
    setHostedReviewCreationState: setState,
    worktreePath: '/repo'
  })
  return null
})

it('builds the failure fallback with the provider inferred after the probe started', async () => {
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  let fail: (error: Error) => void = () => {}
  const probe = new Promise<never>((_resolve, reject) => {
    fail = reject
  })
  const getEligibility = vi.fn(() => probe)
  const setState = vi.fn()
  const { rerender } = render(
    <Host provider="github" getEligibility={getEligibility} setState={setState} />
  )
  rerender(<Host provider="gitlab" getEligibility={getEligibility} setState={setState} />)

  await act(async () => {
    fail(new Error('offline'))
    await probe.catch(() => {})
  })

  expect(getEligibility).toHaveBeenCalledTimes(1)
  expect(setState).toHaveBeenLastCalledWith(
    expect.objectContaining({ data: expect.objectContaining({ provider: 'gitlab' }) })
  )
})
