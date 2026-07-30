import { describe, expect, it, vi } from 'vitest'

vi.mock('@/i18n/i18n', () => ({ translate: (_key: string, fallback: string) => fallback }))

import { WORKTREE_REASON_CODES } from '../../../../shared/audited-worktree-types'
import { getWorktreeErrorMessage } from './audited-worktree-error-messages'
import {
  isRetryableWorktreeReasonCode,
  needsExplicitWorktreeProvisioning
} from './audited-workflow-error-messages'

describe('getWorktreeErrorMessage', () => {
  it.each(WORKTREE_REASON_CODES)('returns user-safe text for %s', (code) => {
    const message = getWorktreeErrorMessage(code)

    expect(message.length).toBeGreaterThan(0)
    // Never leaks identity or internals into renderer-visible text.
    expect(message).not.toContain('.orca-audited')
    expect(message).not.toContain('orca/audited')
    expect(message).not.toContain(code)
  })
})

describe('recovery affordances', () => {
  it('offers Retry only for no-side-effect provisioning failures', () => {
    expect(isRetryableWorktreeReasonCode('git_worktree_add_failed')).toBe(true)
    expect(isRetryableWorktreeReasonCode('managed_root_unavailable')).toBe(true)
    expect(isRetryableWorktreeReasonCode('base_commit_unresolvable')).toBe(true)
  })

  // It can be raised by post-add drift verification, where `git worktree add`
  // already succeeded and the attempt is failed_ambiguous with a guarded path.
  it('never offers Retry for worktree_unreadable', () => {
    expect(isRetryableWorktreeReasonCode('worktree_unreadable')).toBe(false)
    expect(needsExplicitWorktreeProvisioning('worktree_unreadable')).toBe(false)
  })

  it.each([
    'provision_evidence_ambiguous',
    'worktree_path_occupied',
    'repository_identity_mismatch',
    'unsupported_host',
    'managed_root_inside_source_repo',
    'source_repo_inside_managed_root',
    'managed_root_escapes_workspace',
    'head_moved_from_base_commit',
    'branch_tip_moved_from_base_commit',
    'head_not_symbolic',
    'worktree_missing'
  ] as const)('offers no Retry for %s', (code) => {
    expect(isRetryableWorktreeReasonCode(code)).toBe(false)
    expect(needsExplicitWorktreeProvisioning(code)).toBe(false)
  })

  it('offers explicit provisioning only for a legacy task with no worktree', () => {
    expect(needsExplicitWorktreeProvisioning('worktree_never_provisioned')).toBe(true)
    // It is not a "retry" — the affordance and its label differ.
    expect(isRetryableWorktreeReasonCode('worktree_never_provisioned')).toBe(false)
  })
})
