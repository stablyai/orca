import { describe, expect, it } from 'vitest'
import {
  normalizeWorkspaceAttachmentOrigins,
  rebaseWorkspaceAttachmentOrigins
} from './workspace-attachment-origins'
import type { WorkspaceAttachmentOrigin } from './worktree/types'

describe('reference origin validation and merging', () => {
  it('keeps absent legacy hosts but rejects invalid explicit hosts', () => {
    expect(
      normalizeWorkspaceAttachmentOrigins([
        { kind: 'observed', tabId: 'legacy' },
        { kind: 'observed', tabId: 'local', hostId: 'local' },
        { kind: 'observed', tabId: 'remote', hostId: 'ssh:dev' },
        { kind: 'observed', tabId: 'invalid', hostId: 'unsupported-host' },
        { kind: 'observed', tabId: 'blank', hostId: '' },
        { kind: 'observed', tabId: 'null', hostId: null },
        { kind: 'assigned', tabId: 'obsolete-manual-assignment' }
      ]).map((origin) => origin.tabId)
    ).toEqual(['legacy', 'local', 'remote'])
  })
  it('preserves a concurrently observed terminal when a metadata edit removes another', () => {
    const first: WorkspaceAttachmentOrigin = { kind: 'observed', tabId: 'first', hostId: 'local' }
    const other: WorkspaceAttachmentOrigin = { kind: 'observed', tabId: 'other', hostId: 'local' }
    expect(rebaseWorkspaceAttachmentOrigins([first, other], [first], [])).toEqual([other])
  })
  it('keeps identically named tabs on different execution hosts distinct', () => {
    expect(
      normalizeWorkspaceAttachmentOrigins([
        { kind: 'observed', tabId: 'same', hostId: 'local' },
        { kind: 'observed', tabId: 'same', hostId: 'ssh:dev' }
      ])
    ).toHaveLength(2)
  })
})
