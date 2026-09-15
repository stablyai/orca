import { describe, expect, it } from 'vitest'
import { resolveWorkspaceTrustMatch } from './workspace-trust-resolution'
import type { WorkspaceTrustEntry } from './workspace-trust-types'

function makeEntry(overrides: Partial<WorkspaceTrustEntry> = {}): WorkspaceTrustEntry {
  return {
    id: 'entry-1',
    path: '/home/user/work',
    trusted: true,
    decidedAt: 1,
    origin: 'intake',
    ...overrides
  }
}

describe('resolveWorkspaceTrustMatch', () => {
  it('returns the ancestor entry for a repo added later under a trusted parent', () => {
    const entries = [makeEntry({ id: 'parent', path: '/home/user/work', trusted: true })]

    const match = resolveWorkspaceTrustMatch('/home/user/work/proj', entries)

    expect(match).toEqual({ entry: entries[0], matchKind: 'ancestor' })
  })

  it('lets an explicit decline outrank a later ancestor grant, because it is the closer match', () => {
    const declinedChild = makeEntry({ id: 'child', path: '/home/user/work/repo-x', trusted: false })
    const trustedParent = makeEntry({ id: 'parent', path: '/home/user/work', trusted: true })

    const match = resolveWorkspaceTrustMatch('/home/user/work/repo-x', [
      trustedParent,
      declinedChild
    ])

    expect(match).toEqual({ entry: declinedChild, matchKind: 'exact' })
  })

  it('returns null when no stored entry covers the path', () => {
    const entries = [makeEntry({ path: '/home/user/other' })]

    expect(resolveWorkspaceTrustMatch('/home/user/work', entries)).toBeNull()
  })
})
