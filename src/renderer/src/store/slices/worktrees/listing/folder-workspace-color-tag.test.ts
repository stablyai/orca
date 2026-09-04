import { describe, expect, it } from 'vitest'
import { getFolderWorkspaceMetaUpdates } from './detected-worktree-meta'

// Why this exists: the folder-workspace write path is a whitelist, not a spread. A field added to
// WorktreeMeta and projected on read still silently no-ops on folder workspaces until it is
// listed here, and the update reports success either way.
describe('folder workspace color tag writes', () => {
  it('carries an assigned tag through to the folder workspace update', () => {
    expect(getFolderWorkspaceMetaUpdates({ colorTag: '#ef4444' })).toEqual({
      colorTag: '#ef4444'
    })
  })

  it('carries an explicit clear rather than dropping it as "no change"', () => {
    expect(getFolderWorkspaceMetaUpdates({ colorTag: null })).toEqual({ colorTag: null })
  })

  it('leaves the tag untouched when the update does not mention it', () => {
    expect(getFolderWorkspaceMetaUpdates({ isPinned: true })).not.toHaveProperty('colorTag')
  })
})
