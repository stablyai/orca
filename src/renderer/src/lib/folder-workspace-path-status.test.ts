import { describe, expect, it } from 'vitest'
import type { FolderWorkspacePathStatus } from '../../../shared/folder-workspace-path-status'
import {
  getFolderWorkspacePathStatusDescription,
  getFolderWorkspacePathStatusTitle
} from './folder-workspace-path-status'

// Why: the status crosses the runtime RPC wire and is cast, not decoded (`result: z.unknown()`), so
// the cast at the test boundary is the point — a newer host really can put these on the wire.
function wireStatus(reason: unknown): FolderWorkspacePathStatus {
  return { path: '/srv/scans', exists: false, reason } as unknown as FolderWorkspacePathStatus
}

describe('getFolderWorkspacePathStatusTitle', () => {
  it('keeps the declared reasons on their own copy', () => {
    expect(getFolderWorkspacePathStatusTitle(wireStatus('missing'))).toBe('Folder not found')
    expect(getFolderWorkspacePathStatusTitle(wireStatus('not-directory'))).toBe(
      'Path is not a folder'
    )
    expect(getFolderWorkspacePathStatusTitle(wireStatus('ambiguous-connection'))).toBe(
      'Cannot determine connection'
    )
    expect(getFolderWorkspacePathStatusTitle(wireStatus('unavailable'))).toBe('Cannot check folder')
    expect(getFolderWorkspacePathStatusTitle(wireStatus(undefined))).toBe('Cannot check folder')
  })

  it('still titles a broken folder when a newer host sends an undeclared reason', () => {
    const title = getFolderWorkspacePathStatusTitle(wireStatus('permission-denied'))

    expect(typeof title).toBe('string')
    expect(title).not.toBe('')
  })

  // Why: Object.hasOwn coerces its key, so ['missing'] passes a hasOwn-only guard and then falls
  // straight back out of the switch — the exact P1 found in review on #15002.
  it('does not admit a non-string reason through the membership guard', () => {
    const title = getFolderWorkspacePathStatusTitle(wireStatus(['missing']))

    expect(typeof title).toBe('string')
    expect(title).not.toBe('')
    expect(title).not.toBe('Folder not found')
  })

  it('stays silent for a healthy or absent status', () => {
    expect(getFolderWorkspacePathStatusTitle(null)).toBeNull()
    expect(getFolderWorkspacePathStatusTitle({ path: '/srv/scans', exists: true })).toBeNull()
  })
})

describe('getFolderWorkspacePathStatusDescription', () => {
  it('keeps the declared reasons on their own copy', () => {
    expect(getFolderWorkspacePathStatusDescription(wireStatus('missing'))).toBe(
      'Orca cannot find /srv/scans. Remove and re-import this folder workspace.'
    )
    expect(getFolderWorkspacePathStatusDescription(wireStatus(undefined))).toBe(
      'Orca cannot verify this folder right now. Check the runtime or SSH connection and try again.'
    )
  })

  it('still describes a broken folder when a newer host sends an undeclared reason', () => {
    const description = getFolderWorkspacePathStatusDescription(wireStatus('permission-denied'))

    expect(typeof description).toBe('string')
    expect(description).not.toBe('')
    expect(description).toContain('/srv/scans')
  })

  it('does not admit a non-string reason through the membership guard', () => {
    const description = getFolderWorkspacePathStatusDescription(wireStatus(['missing']))

    expect(typeof description).toBe('string')
    expect(description).not.toBe('')
    expect(description).not.toBe(
      'Orca cannot find /srv/scans. Remove and re-import this folder workspace.'
    )
  })
})
