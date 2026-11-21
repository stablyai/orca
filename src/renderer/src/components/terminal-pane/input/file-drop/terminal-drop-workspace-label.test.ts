import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => {
  const holder: { state: Record<string, unknown> } = { state: {} }
  return holder
})

vi.mock('@/store', () => ({ useAppStore: { getState: () => mocks.state } }))
vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string, values: { workspace: string }) =>
    fallback.replace('{{workspace}}', values.workspace)
}))

import { describeDropWorkspaceIfInactive } from './terminal-drop-workspace-label'

describe('describeDropWorkspaceIfInactive', () => {
  beforeEach(() => {
    mocks.state = {
      activeWorktreeId: 'wt-a',
      folderWorkspaces: [],
      worktreesByRepo: {
        'repo-a': [
          { id: 'wt-a', displayName: '', branch: 'refs/heads/main', path: '/srv/repo/main' },
          { id: 'wt-b', displayName: 'ux-polish', branch: 'refs/heads/x', path: '/srv/repo/x' }
        ]
      }
    }
  })

  it('stays silent when the drop went to the active workspace', () => {
    expect(describeDropWorkspaceIfInactive('wt-a', '/srv/repo/main')).toBeUndefined()
  })

  it('names the workspace the user switched away from', () => {
    expect(describeDropWorkspaceIfInactive('wt-b', '/srv/repo/x')).toBe('Dropped into ux-polish')
  })

  it('names a folder workspace the way the sidebar does', () => {
    mocks.state = {
      ...mocks.state,
      repos: [],
      projectGroups: [{ id: 'group-1', name: 'Research', parentGroupId: null }],
      folderWorkspaces: [
        {
          id: 'notes',
          projectGroupId: 'group-1',
          name: 'Research notes',
          folderPath: '/srv/notes'
        }
      ]
    }

    expect(describeDropWorkspaceIfInactive('folder:notes', '/srv/notes')).toBe(
      'Dropped into Research notes'
    )
  })

  it('falls back to the folder name for a workspace the catalog no longer has', () => {
    expect(describeDropWorkspaceIfInactive('wt-gone', '/srv/repo/gone')).toBe('Dropped into gone')
  })
})
