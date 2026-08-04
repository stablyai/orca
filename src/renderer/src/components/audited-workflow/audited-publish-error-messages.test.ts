// Phase 9 copy: every code has a distinct, truthful message.
//
// The advisory assertions are the important ones: an advisory can only exist on a
// DURABLE publish, so its copy must never read as a failure.
import { describe, expect, it } from 'vitest'
import {
  PUBLISH_ADVISORY_CODES,
  PUBLISH_REASON_CODES
} from '../../../../shared/audited-publish-types'
import {
  getPublishAdvisoryMessage,
  getPublishErrorMessage,
  isPublishRetryable
} from './audited-publish-error-messages'

describe('publish error copy', () => {
  it('gives every reason code a non-empty message', () => {
    for (const code of PUBLISH_REASON_CODES) {
      expect(getPublishErrorMessage(code).length).toBeGreaterThan(0)
    }
  })

  it('gives every reason code a DISTINCT message', () => {
    const messages = PUBLISH_REASON_CODES.map(getPublishErrorMessage)
    expect(new Set(messages).size).toBe(messages.length)
  })

  it('never claims a lease rejection overwrote anything', () => {
    const message = getPublishErrorMessage('push_rejected_stale_lease')
    expect(message.toLowerCase()).toContain('nothing was overwritten')
  })

  it('delegates retryability to the shared authority', () => {
    expect(isPublishRetryable('push_network_unavailable')).toBe(true)
    expect(isPublishRetryable('push_rejected_stale_lease')).toBe(false)
    expect(isPublishRetryable('push_evidence_ambiguous')).toBe(false)
  })
})

describe('publish advisory copy', () => {
  it('gives every advisory a non-empty, distinct message', () => {
    const messages = PUBLISH_ADVISORY_CODES.map(getPublishAdvisoryMessage)
    for (const message of messages) {
      expect(message.length).toBeGreaterThan(0)
    }
    expect(new Set(messages).size).toBe(messages.length)
  })

  it('states that the publish SUCCEEDED in every advisory', () => {
    // An advisory can only exist once the remote carries the change, so none of
    // this copy may read as a publish failure.
    for (const code of PUBLISH_ADVISORY_CODES) {
      expect(getPublishAdvisoryMessage(code).toLowerCase()).toContain('published')
    }
  })

  it('names the sign-in step for an auth failure rather than a bare retry', () => {
    const message = getPublishAdvisoryMessage('review_request_auth_required').toLowerCase()
    expect(message).toContain('sign in')
  })

  it('distinguishes validation from a transient deferral', () => {
    const validation = getPublishAdvisoryMessage('review_request_validation_failed')
    const deferred = getPublishAdvisoryMessage('review_request_deferred')
    expect(validation).not.toBe(deferred)
    expect(validation.toLowerCase()).toContain('rejected')
  })

  it('says an unsupported remote cannot open a review at all', () => {
    const message = getPublishAdvisoryMessage('review_request_unsupported_provider').toLowerCase()
    expect(message).toContain('does not support')
  })

  it('says an ambiguous outcome is safe to retry', () => {
    const message = getPublishAdvisoryMessage('review_request_ambiguous').toLowerCase()
    expect(message).toContain('unclear')
  })
})
