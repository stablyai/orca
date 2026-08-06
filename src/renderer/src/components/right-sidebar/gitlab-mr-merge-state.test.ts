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
