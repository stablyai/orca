import { describe, expect, it } from 'vitest'
import { roomProjectId } from './RoomsPage'

describe('roomProjectId', () => {
  it('uses repo projects and supports non-git folder workspaces', () => {
    expect(roomProjectId('repo-1', 'worktree:repo-1::/repo')).toBe('repo-1')
    expect(roomProjectId(null, 'folder:folder-1')).toBe('folder:folder-1')
    expect(roomProjectId('repo-1', 'folder:folder-1')).toBe('folder:folder-1')
    expect(roomProjectId(null, null)).toBeNull()
  })
})
