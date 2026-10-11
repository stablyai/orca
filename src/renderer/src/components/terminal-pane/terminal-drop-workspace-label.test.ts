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

  it('falls back to the folder name for a workspace outside worktreesByRepo', () => {
    expect(describeDropWorkspaceIfInactive('folder:notes', '/srv/notes')).toBe('Dropped into notes')
  })
})
