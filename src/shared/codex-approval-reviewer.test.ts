import { describe, expect, it } from 'vitest'
import {
  parseExplicitCodexApprovalReviewer,
  resolveCodexApprovalReviewer
} from './codex-approval-reviewer'

describe('Codex approval reviewer', () => {
  it('accepts only explicit reviewer values from hook transport', () => {
    expect(parseExplicitCodexApprovalReviewer('auto_review')).toBe('auto_review')
    expect(parseExplicitCodexApprovalReviewer('user')).toBe('user')
    expect(parseExplicitCodexApprovalReviewer('guardian_subagent')).toBeUndefined()
    expect(parseExplicitCodexApprovalReviewer('AUTO_REVIEW')).toBeUndefined()
  })

  it('uses the last explicit reviewer declaration', () => {
    expect(
      resolveCodexApprovalReviewer(
        `-c approvals_reviewer=auto_review -c 'approvals_reviewer="user"'`
      )
    ).toBe('user')
    expect(resolveCodexApprovalReviewer(`-c approvals_reviewer=guardian_subagent`)).toBe(
      'auto_review'
    )
    expect(resolveCodexApprovalReviewer('--ask-for-approval on-request')).toBe('unknown')
  })
})
