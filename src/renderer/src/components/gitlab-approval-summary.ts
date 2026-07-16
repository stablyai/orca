import { translate } from '@/i18n/i18n'

type GitLabApprovalSummary = {
  approvalsLeft: number | null
  approvalsRequired: number | null
}

export function getGitLabApprovalSummary(state: GitLabApprovalSummary): string {
  if (state.approvalsLeft === 0) {
    if (typeof state.approvalsRequired === 'number') {
      return translate(
        'auto.components.GitLabItemDialog.approvedWithRequirement',
        'Approved · {{requiredCount}} required',
        { requiredCount: state.approvalsRequired }
      )
    }
    return translate('auto.components.GitLabItemDialog.22511537d2', 'Approved')
  }

  // Why: approval count and requirement form one translatable sentence;
  // concatenated English suffixes and fragments prevent natural word order.
  const remainingCount = state.approvalsLeft ?? 0
  if (typeof state.approvalsRequired === 'number') {
    return remainingCount === 1
      ? translate(
          'auto.components.GitLabItemDialog.oneApprovalRemainingOfRequired',
          '{{remainingCount}} approval remaining of {{requiredCount}} required',
          { remainingCount, requiredCount: state.approvalsRequired }
        )
      : translate(
          'auto.components.GitLabItemDialog.manyApprovalsRemainingOfRequired',
          '{{remainingCount}} approvals remaining of {{requiredCount}} required',
          { remainingCount, requiredCount: state.approvalsRequired }
        )
  }

  return remainingCount === 1
    ? translate(
        'auto.components.GitLabItemDialog.oneApprovalRemaining',
        '{{remainingCount}} approval remaining',
        { remainingCount }
      )
    : translate(
        'auto.components.GitLabItemDialog.manyApprovalsRemaining',
        '{{remainingCount}} approvals remaining',
        { remainingCount }
      )
}
