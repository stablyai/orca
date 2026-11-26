// @vitest-environment happy-dom

import { describe, expect, it } from 'vitest'
import { useAppStore } from '@/store/index'
import type { AppState } from '@/store/types'
import type { WorkspaceSessionState } from '../../../../../../shared/workspace-session/workspace-session-state-types'
import { buildWorkspaceSessionPayload } from '../../../../lib/workspace/persistence/workspace-session'

describe('an unsaved draft whose workspace folder disappeared while Orca was closed', () => {
  it('is still in the session the window saves after restoring', () => {
    useAppStore.setState(useAppStore.getInitialState(), true)
    useAppStore.setState(
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a partial catalog with only the fields hydration validity reads.
      {
        repos: [{ id: 'repo', path: '/repo', kind: 'git', executionHostId: 'local' }],
        worktreesByRepo: {
          repo: [{ id: 'repo::/repo', repoId: 'repo', path: '/repo', hostId: 'local', branch: '' }]
        },
        detectedWorktreesByRepo: {},
        folderWorkspaces: []
      } as unknown as Partial<AppState>
    )
    const session: WorkspaceSessionState = {
      activeRepoId: null,
      activeWorktreeId: null,
      activeTabId: null,
      tabsByWorktree: {},
      terminalLayoutsByTabId: {},
      openFilesByWorktree: {
        'repo::/gone': [
          {
            filePath: '/gone/a.md',
            relativePath: 'a.md',
            worktreeId: 'repo::/gone',
            language: 'markdown',
            dirtyDraftContent: 'unsaved'
          }
        ]
      }
    }

    useAppStore.getState().hydrateEditorSession(session)
    const saved = buildWorkspaceSessionPayload(useAppStore.getState())

    expect(saved.openFilesByWorktree?.['repo::/gone']).toEqual([
      expect.objectContaining({ filePath: '/gone/a.md', dirtyDraftContent: 'unsaved' })
    ])
  })
})
