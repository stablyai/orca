import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { HostedReviewApproval } from '../../../../shared/hosted-review'
import { GitLabApprovalButton, gitLabApprovalProgressLabel } from './GitLabApprovalAction'

const base: HostedReviewApproval = {
  approvalsRequired: 2,
  approvalsLeft: 1,
  approvedCount: 1,
  userCanApprove: false,
  userHasApproved: false
}

function render(
  approval: HostedReviewApproval,
  opts: { disabled?: boolean; pending?: boolean } = {}
): string {
  return renderToStaticMarkup(
    <GitLabApprovalButton
      approval={approval}
      disabled={opts.disabled ?? false}
      pending={opts.pending ?? false}
      onApprovalChange={vi.fn()}
    />
  )
}

describe('GitLabApprovalButton', () => {
  it('offers Approve when GitLab says the user can approve', () => {
    const markup = render({ ...base, userCanApprove: true })
    expect(markup).toContain('Approve')
    expect(markup).not.toContain('Revoke approval')
  })
  it('offers Revoke approval once approved, even when GitLab reports userCanApprove false', () => {
    expect(render({ ...base, userHasApproved: true })).toContain('Revoke approval')
  })
  it('renders nothing when the user can neither approve nor revoke', () => {
    expect(render(base)).toBe('')
  })
  it('is disabled while a sibling action runs', () => {
    expect(render({ ...base, userCanApprove: true }, { disabled: true })).toContain('disabled=""')
  })
  it('is disabled while its own request is in flight', () => {
    expect(render({ ...base, userCanApprove: true }, { pending: true })).toContain('disabled=""')
  })
})

describe('gitLabApprovalProgressLabel', () => {
  it('shows progress while approvals are outstanding', () => {
    expect(gitLabApprovalProgressLabel(base)).toBe('1 of 2 approvals')
  })
  it('shows Approved when no approvals are left', () => {
    expect(gitLabApprovalProgressLabel({ ...base, approvalsLeft: 0, approvedCount: 2 })).toBe(
      'Approved'
    )
  })
  it('shows Approved for an optional approval that was given', () => {
    expect(
      gitLabApprovalProgressLabel({
        ...base,
        approvalsRequired: 0,
        approvalsLeft: 0,
        approvedCount: 1
      })
    ).toBe('Approved')
  })
  it('shows nothing when no approval is required or given', () => {
    expect(
      gitLabApprovalProgressLabel({
        ...base,
        approvalsRequired: 0,
        approvalsLeft: 0,
        approvedCount: 0
      })
    ).toBeNull()
  })
  it('never shows negative progress for inconsistent counts', () => {
    expect(gitLabApprovalProgressLabel({ ...base, approvalsRequired: 2, approvalsLeft: 3 })).toBe(
      '0 of 2 approvals'
    )
  })
})
