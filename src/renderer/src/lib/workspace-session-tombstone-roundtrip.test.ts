import { describe, expect, it } from 'vitest'
import { buildWorkspaceSessionPatch } from './workspace-session-patch'
import { SESSION_RELEVANT_FIELDS } from './workspace-session'

describe('closed tab tombstones in the persisted session', () => {
  it('is a session-relevant field', () => {
    expect(SESSION_RELEVANT_FIELDS).toContain('closedTerminalTabTombstonesByTabId')
  })

  it('patch includes pruned tombstones when the field changed', () => {
    const snapshot = {
      closedTerminalTabTombstonesByTabId: {
        'tab-1': { closedAt: Date.now(), worktreeId: 'wt-1' }
      }
    } as never
    const patch = buildWorkspaceSessionPatch(snapshot, ['closedTerminalTabTombstonesByTabId'])
    expect(patch.closedTerminalTabTombstonesByTabId).toEqual({
      'tab-1': expect.objectContaining({ worktreeId: 'wt-1' })
    })
  })

  it('patch omits the field when the map is empty', () => {
    const snapshot = { closedTerminalTabTombstonesByTabId: {} } as never
    const patch = buildWorkspaceSessionPatch(snapshot, ['closedTerminalTabTombstonesByTabId'])
    expect(patch.closedTerminalTabTombstonesByTabId).toBeUndefined()
  })
})
