import { beforeEach, describe, expect, it, vi } from 'vitest'
import { getGitLabApprovalSummary } from './gitlab-approval-summary'

const mocks = vi.hoisted(() => ({
  translate: vi.fn((_key: string, fallback: string) => fallback)
}))

vi.mock('@/i18n/i18n', () => ({
  translate: mocks.translate
}))

describe('getGitLabApprovalSummary', () => {
  beforeEach(() => {
    mocks.translate.mockClear()
  })

  it('preserves the required count when all approvals are satisfied', () => {
    getGitLabApprovalSummary({ approvalsLeft: 0, approvalsRequired: 3 })

    expect(mocks.translate).toHaveBeenCalledWith(
      'auto.components.GitLabItemDialog.approvedWithRequirement',
      'Approved · {{requiredCount}} required',
      { requiredCount: 3 }
    )
  })

  it('uses complete singular and plural messages when a requirement is known', () => {
    getGitLabApprovalSummary({ approvalsLeft: 1, approvalsRequired: 3 })
    getGitLabApprovalSummary({ approvalsLeft: 2, approvalsRequired: 3 })

    expect(mocks.translate).toHaveBeenNthCalledWith(
      1,
      'auto.components.GitLabItemDialog.oneApprovalRemainingOfRequired',
      '{{remainingCount}} approval remaining of {{requiredCount}} required',
      { remainingCount: 1, requiredCount: 3 }
    )
    expect(mocks.translate).toHaveBeenNthCalledWith(
      2,
      'auto.components.GitLabItemDialog.manyApprovalsRemainingOfRequired',
      '{{remainingCount}} approvals remaining of {{requiredCount}} required',
      { remainingCount: 2, requiredCount: 3 }
    )
  })

  it('uses complete messages without appending a translated requirement fragment', () => {
    getGitLabApprovalSummary({ approvalsLeft: 1, approvalsRequired: null })
    getGitLabApprovalSummary({ approvalsLeft: 4, approvalsRequired: null })

    expect(mocks.translate).toHaveBeenNthCalledWith(
      1,
      'auto.components.GitLabItemDialog.oneApprovalRemaining',
      '{{remainingCount}} approval remaining',
      { remainingCount: 1 }
    )
    expect(mocks.translate).toHaveBeenNthCalledWith(
      2,
      'auto.components.GitLabItemDialog.manyApprovalsRemaining',
      '{{remainingCount}} approvals remaining',
      { remainingCount: 4 }
    )
  })
})
