import { describe, expect, it } from 'vitest'
import { resolveWorkspacePinToggleTarget } from './workspace-pin-toggle'

describe('resolveWorkspacePinToggleTarget', () => {
  it('returns the inverted pin state for a known workspace', () => {
    expect(
      resolveWorkspacePinToggleTarget({ worktreeId: 'wt-1', isPinned: false })
    ).toEqual({ worktreeId: 'wt-1', nextPinned: true })
    expect(
      resolveWorkspacePinToggleTarget({ worktreeId: 'wt-1', isPinned: true })
    ).toEqual({ worktreeId: 'wt-1', nextPinned: false })
  })

  it('no-ops without an active workspace id', () => {
    expect(resolveWorkspacePinToggleTarget({ worktreeId: null, isPinned: false })).toBeNull()
    expect(resolveWorkspacePinToggleTarget({ worktreeId: undefined, isPinned: true })).toBeNull()
    expect(resolveWorkspacePinToggleTarget({ worktreeId: '', isPinned: false })).toBeNull()
  })

  it('no-ops when pin state is unknown (worktree not in store)', () => {
    expect(resolveWorkspacePinToggleTarget({ worktreeId: 'wt-1', isPinned: null })).toBeNull()
    expect(resolveWorkspacePinToggleTarget({ worktreeId: 'wt-1', isPinned: undefined })).toBeNull()
  })
})
