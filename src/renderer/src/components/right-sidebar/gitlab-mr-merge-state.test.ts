import { describe, expect, it } from 'vitest'
import { presentGitLabMRMergeState } from './gitlab-mr-merge-state'

describe('presentGitLabMRMergeState', () => {
  it('does not treat UNKNOWN as able to merge', () => {
    expect(
      presentGitLabMRMergeState({
        state: 'open',
        status: 'success',
        mergeable: 'UNKNOWN',
        mergeStateStatus: 'not_approved'
      })
    ).toMatchObject({
      label: 'Approval required',
      directMergeAvailable: false
    })
  })

  it('labels common blocked detailed_merge_status values', () => {
    expect(
      presentGitLabMRMergeState({
        state: 'open',
        status: 'pending',
        mergeable: 'UNKNOWN',
        mergeStateStatus: 'ci_still_running'
      }).label
    ).toBe('Checks pending')
    expect(
      presentGitLabMRMergeState({
        state: 'open',
        status: 'success',
        mergeable: 'UNKNOWN',
        mergeStateStatus: 'discussions_not_resolved'
      }).label
    ).toBe('Unresolved threads')
  })

  // Unknown merge reasons must not hide the actionable failed pipeline behind Checking.
  it('surfaces a failed pipeline when GitLab reports no usable merge reason', () => {
    expect(
      presentGitLabMRMergeState({
        state: 'open',
        status: 'failure',
        mergeable: 'UNKNOWN',
        mergeStateStatus: undefined
      })
    ).toMatchObject({
      label: 'Checks failed',
      directMergeAvailable: false
    })
  })

  // New GitLab reason values must degrade like missing reasons instead of claiming merge readiness.
  it('treats an unrecognised merge reason like an absent one', () => {
    expect(
      presentGitLabMRMergeState({
        state: 'open',
        status: 'failure',
        mergeable: 'UNKNOWN',
        mergeStateStatus: 'some_future_gitlab_status'
      })
    ).toMatchObject({
      label: 'Checks failed',
      directMergeAvailable: false
    })
    expect(
      presentGitLabMRMergeState({
        state: 'open',
        status: 'success',
        mergeable: 'UNKNOWN',
        mergeStateStatus: 'some_future_gitlab_status'
      })
    ).toMatchObject({
      label: 'Checking',
      directMergeAvailable: false
    })
  })

  it('still reports Checking when there is no reason and no failing pipeline', () => {
    expect(
      presentGitLabMRMergeState({
        state: 'open',
        status: 'pending',
        mergeable: 'UNKNOWN',
        mergeStateStatus: undefined
      }).label
    ).toBe('Checking')
  })

  it('keeps an explicit GitLab reason ahead of the pipeline result', () => {
    expect(
      presentGitLabMRMergeState({
        state: 'open',
        status: 'failure',
        mergeable: 'UNKNOWN',
        mergeStateStatus: 'not_approved'
      }).label
    ).toBe('Approval required')
  })

  it('only offers direct merge when GitLab reports MERGEABLE', () => {
    expect(
      presentGitLabMRMergeState({
        state: 'open',
        status: 'success',
        mergeable: 'MERGEABLE',
        mergeStateStatus: 'mergeable'
      })
    ).toMatchObject({
      label: 'Able to merge',
      directMergeAvailable: true
    })
  })
})
