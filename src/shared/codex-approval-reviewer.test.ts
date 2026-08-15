import { describe, expect, it } from 'vitest'
import {
  parseExplicitCodexApprovalReviewer,
  resolveAuthoritativeCodexApprovalReviewer,
  resolveCodexApprovalReviewer
} from './codex-approval-reviewer'

describe('Codex approval reviewer', () => {
  it('accepts only explicit reviewer values from hook transport', () => {
    expect(parseExplicitCodexApprovalReviewer('auto_review')).toBe('auto_review')
    expect(parseExplicitCodexApprovalReviewer('user')).toBe('user')
    expect(parseExplicitCodexApprovalReviewer('guardian_subagent')).toBeUndefined()
    expect(parseExplicitCodexApprovalReviewer('AUTO_REVIEW')).toBeUndefined()
  })

  it('uses the last explicit auto_review or user declaration', () => {
    expect(
      resolveCodexApprovalReviewer(
        `-c approvals_reviewer=auto_review -c 'approvals_reviewer="user"'`
      )
    ).toBe('user')
    expect(resolveCodexApprovalReviewer(`-c approvals_reviewer=auto_review`)).toBe('auto_review')
    expect(resolveCodexApprovalReviewer('--ask-for-approval on-request')).toBe('unknown')
  })

  it('does not widen guardian_subagent to auto_review', () => {
    expect(resolveCodexApprovalReviewer(`-c approvals_reviewer=guardian_subagent`)).toBe(
      'unknown'
    )
    expect(
      resolveCodexApprovalReviewer(
        `-c approvals_reviewer=guardian_subagent -c approvals_reviewer=auto_review`
      )
    ).toBe('auto_review')
  })

  it('binds authority to launch agentArgs and ignores spoofed wire auto_review', () => {
    expect(
      resolveAuthoritativeCodexApprovalReviewer({
        agentArgs: `-c 'approvals_reviewer="user"'`,
        wireReviewer: 'auto_review'
      })
    ).toBe('user')
    expect(
      resolveAuthoritativeCodexApprovalReviewer({
        agentArgs: null,
        wireReviewer: 'auto_review'
      })
    ).toBe('unknown')
    expect(
      resolveAuthoritativeCodexApprovalReviewer({
        agentArgs: `-c 'approvals_reviewer="auto_review"'`,
        wireReviewer: 'user'
      })
    ).toBe('auto_review')
  })
})
