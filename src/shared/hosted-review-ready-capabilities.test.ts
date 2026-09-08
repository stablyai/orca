import { describe, expect, it } from 'vitest'
import {
  GITHUB_MARK_PR_READY_RUNTIME_CAPABILITY,
  GITLAB_READY_FOR_REVIEW_RUNTIME_CAPABILITY,
  RUNTIME_CAPABILITIES
} from './protocol-version'

describe('hosted review Ready capabilities', () => {
  it('advertises both provider mutation contracts', () => {
    expect(RUNTIME_CAPABILITIES).toContain(GITHUB_MARK_PR_READY_RUNTIME_CAPABILITY)
    expect(RUNTIME_CAPABILITIES).toContain(GITLAB_READY_FOR_REVIEW_RUNTIME_CAPABILITY)
  })
})
