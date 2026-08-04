// Sanitized copy for the Phase 10 landing lane.
//
// NOTHING IDENTIFYING MAY APPEAR IN ANY STRING: no path, sha, branch, or Git
// jargon. This is the one lane whose messages describe the user's OWN repository,
// so naming it would leak the single path the feature must never project.
//
// AND EVERY ADVISORY MUST READ AS A SUCCESS, because by the time one can be
// written the branch has already moved.
import { describe, expect, it } from 'vitest'
import { LANDING_ADVISORY_CODES } from '../../../../shared/audited-landing-types'
import { LANDING_REASON_CODES } from '../../../../shared/audited-workflow-types'
import {
  getLandingAdvisoryMessage,
  getLandingErrorMessage,
  isLandingRetryable
} from './audited-landing-error-messages'

describe('every closed code has copy', () => {
  it('gives every LANDING_REASON_CODES member a non-empty message', () => {
    for (const code of LANDING_REASON_CODES) {
      expect(getLandingErrorMessage(code).length).toBeGreaterThan(0)
    }
  })

  it('gives every LANDING_ADVISORY_CODES member a non-empty message', () => {
    for (const code of LANDING_ADVISORY_CODES) {
      expect(getLandingAdvisoryMessage(code).length).toBeGreaterThan(0)
    }
  })

  it('produces distinct messages, so no two codes are indistinguishable', () => {
    const messages = LANDING_REASON_CODES.map(getLandingErrorMessage)
    expect(new Set(messages).size).toBe(messages.length)
  })
})

describe('no message leaks identity', () => {
  const all = [
    ...LANDING_REASON_CODES.map(getLandingErrorMessage),
    ...LANDING_ADVISORY_CODES.map(getLandingAdvisoryMessage)
  ]

  it('embeds no sha-like hex run', () => {
    for (const message of all) {
      expect(message).not.toMatch(/[0-9a-f]{7,}/)
    }
  })

  it('embeds no path separator', () => {
    for (const message of all) {
      expect(message).not.toMatch(/\/|\\/)
    }
  })

  it('embeds no Git jargon a user cannot act on', () => {
    for (const message of all) {
      expect(message).not.toMatch(/refs\/heads|update-ref|read-tree|stderr|argv|--force/)
    }
  })
})

describe('advisories state SUCCESS first — the branch moved', () => {
  it.each([...LANDING_ADVISORY_CODES])('%s begins with Landed', (code) => {
    expect(getLandingAdvisoryMessage(code)).toMatch(/^Landed/)
  })
})

describe('retryability is a closed, deliberate set', () => {
  it.each([
    ['lock_contended'],
    ['source_repo_dirty'],
    ['source_repo_not_at_base_commit'],
    ['source_repo_branch_not_checked_out'],
    ['interrupted']
  ] as const)('offers a retry for %s', (code) => {
    expect(isLandingRetryable(code)).toBe(true)
  })

  it.each([
    ['landing_evidence_ambiguous'],
    ['integration_required'],
    ['source_repo_mismatch'],
    ['source_repo_missing'],
    // ALL FOUR publication-gate codes: each needs a successful Publish, which is
    // a different command, not a Land-button retry.
    ['task_not_published'],
    ['publish_sha_mismatch'],
    ['publish_not_confirmed'],
    ['publish_in_progress']
  ] as const)('refuses a retry for %s', (code) => {
    expect(isLandingRetryable(code)).toBe(false)
  })
})
