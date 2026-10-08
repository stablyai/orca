import { describe, expect, it } from 'vitest'
import {
  RUNTIME_CAPABILITIES,
  WORKTREE_ARCHIVE_FAILURE_BLOCKING_RUNTIME_CAPABILITY
} from '../protocol-version'

// Why (#19334): the reporter's integration (Harbour) keeps its teardown ownership evidence inside
// the checkout, so it must know *before* removing anything whether this host refuses to delete on a
// failed archive hook. It cannot probe for that — probing means risking the data loss.
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
