import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { BLOCK_REASON_CODES, RECONCILE_REASON_CODES } from './audited-workflow-types'
import {
  REGISTRY_GUARDED_ATTEMPT_STATUSES,
  REGISTRY_RELEASED_ATTEMPT_STATUSES,
  RETRYABLE_PROVISIONING_REASON_CODES,
  WORKTREE_ATTEMPT_STATUSES,
  WORKTREE_REASON_CODES,
  isRetryableProvisioningReasonCode
} from './audited-worktree-types'
import {
  mapWorktreeReasonToBlockReason,
  mapWorktreeReasonToReconcileClass,
  mapWorktreeReasonToReconcileReason
} from './audited-worktree-reason-mapping'

describe('WorktreeReasonCode vocabulary', () => {
  it('contains failures only — success is the ok:true arm, never a member', () => {
    expect(WORKTREE_REASON_CODES).not.toContain('provision_ok')
    expect(WORKTREE_REASON_CODES.some((code) => code.endsWith('_ok'))).toBe(false)
  })

  it('never carries contention, which is a command result and never persisted', () => {
    expect(WORKTREE_REASON_CODES).not.toContain('lock_contended')
    expect(WORKTREE_REASON_CODES).not.toContain('provision_attempt_contended')
  })
})

describe('reason mappings are total', () => {
  it.each(WORKTREE_REASON_CODES)('maps %s to one of the two generic block codes', (code) => {
    const blockReason = mapWorktreeReasonToBlockReason(code)
    expect(['worktree_provision_failed', 'worktree_drift_detected']).toContain(blockReason)
    expect(BLOCK_REASON_CODES).toContain(blockReason)
  })

  it.each(WORKTREE_REASON_CODES)('maps %s to an existing reconcile reason', (code) => {
    expect(RECONCILE_REASON_CODES).toContain(mapWorktreeReasonToReconcileReason(code))
  })

  it.each(WORKTREE_REASON_CODES)('maps %s to a reconcile class', (code) => {
    expect(['resumable', 'needs_attention', 'completed', 'failed']).toContain(
      mapWorktreeReasonToReconcileClass(code)
    )
  })

  it('uses no casts in the mapping module', () => {
    const source = readFileSync(join(__dirname, 'audited-worktree-reason-mapping.ts'), 'utf8')
    expect(source).not.toContain('as never')
    expect(source).not.toMatch(/\bas [A-Z]/)
    // Exhaustive switches only: a `default` would hide an unmapped addition.
    expect(source).not.toContain('default:')
  })
})

describe('attempt status partition', () => {
  it('guarded and released statuses partition the full set exactly', () => {
    const guarded = new Set<string>(REGISTRY_GUARDED_ATTEMPT_STATUSES)
    const released = new Set<string>(REGISTRY_RELEASED_ATTEMPT_STATUSES)

    for (const status of WORKTREE_ATTEMPT_STATUSES) {
      expect(guarded.has(status) !== released.has(status)).toBe(true)
    }
    expect(guarded.size + released.size).toBe(WORKTREE_ATTEMPT_STATUSES.length)
  })

  it('has no bare `failed` status — it is split so membership is status-derived', () => {
    expect(WORKTREE_ATTEMPT_STATUSES).not.toContain('failed')
    expect(WORKTREE_ATTEMPT_STATUSES).toContain('failed_ambiguous')
    expect(WORKTREE_ATTEMPT_STATUSES).toContain('failed_no_effect')
  })

  it('keeps ambiguous evidence guarded and releases only proven-absent outcomes', () => {
    expect(REGISTRY_GUARDED_ATTEMPT_STATUSES).toContain('failed_ambiguous')
    expect(REGISTRY_RELEASED_ATTEMPT_STATUSES).toEqual(['failed_no_effect', 'abandoned'])
  })
})

describe('retryable provisioning reasons', () => {
  it('excludes every outcome that can leave partial Git evidence', () => {
    for (const code of [
      'provision_evidence_ambiguous',
      'worktree_path_occupied',
      'branch_already_exists',
      'repository_identity_mismatch',
      'unsupported_host',
      'managed_root_inside_source_repo',
      'source_repo_inside_managed_root',
      'managed_root_escapes_workspace'
    ] as const) {
      expect(isRetryableProvisioningReasonCode(code)).toBe(false)
    }
  })

  // Excluded because it can be raised by post-add drift verification, i.e.
  // AFTER `git worktree add` succeeded — the attempt is then failed_ambiguous
  // with its path still guarded, so a retry would be unsafe.
  it('excludes worktree_unreadable', () => {
    expect(isRetryableProvisioningReasonCode('worktree_unreadable')).toBe(false)
    expect(RETRYABLE_PROVISIONING_REASON_CODES).not.toContain('worktree_unreadable')
  })

  it('lists only codes that MAY be retryable, subject to durable attempt state', () => {
    expect([...RETRYABLE_PROVISIONING_REASON_CODES].sort()).toEqual([
      'base_commit_unresolvable',
      'git_worktree_add_failed',
      'managed_root_unavailable'
    ])
  })
})
