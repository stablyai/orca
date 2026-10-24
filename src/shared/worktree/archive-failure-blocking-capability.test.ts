import { describe, expect, it } from 'vitest'
import {
  RUNTIME_CAPABILITIES,
  WORKTREE_ARCHIVE_FAILURE_BLOCKING_RUNTIME_CAPABILITY
} from '../protocol-version'

// Callers keeping teardown evidence in the checkout must know the hook gate exists without risking deletion to probe it (#19334).
describe('worktree.archive-failure-blocking.v1', () => {
  it('uses the id the reporting integration already codes against', () => {
    expect(WORKTREE_ARCHIVE_FAILURE_BLOCKING_RUNTIME_CAPABILITY).toBe(
      'worktree.archive-failure-blocking.v1'
    )
  })

  it('is advertised by every build that carries the gate', () => {
    expect(RUNTIME_CAPABILITIES).toContain(WORKTREE_ARCHIVE_FAILURE_BLOCKING_RUNTIME_CAPABILITY)
  })
})
