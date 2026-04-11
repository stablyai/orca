import { describe, expect, it } from 'vitest'
import { buildWorkspaceSessionPayload } from './workspace-session'
import type { AppState } from '../store'

function createSnapshot(overrides: Partial<AppState> = {}): AppState {
  return {
    activeRepoId: 'repo-1',
    activeWorktreeId: 'wt-1',
    activeTabId: 'tab-1',
    tabsByWorktree: {
      'wt-1': [{ id: 'tab-1', title: 'shell', ptyId: 'pty-1', worktreeId: 'wt-1' }],
      'wt-2': [{ id: 'tab-2', title: 'editor', ptyId: null, worktreeId: 'wt-2' }]
    },
    terminalLayoutsByTabId: {
      'tab-1': { root: null, activeLeafId: null, expandedLeafId: null }
    },
    activeTabIdByWorktree: { 'wt-1': 'tab-1', 'wt-2': 'tab-2' },
    openFiles: [
      {
        filePath: '/tmp/demo.ts',
        relativePath: 'demo.ts',
        worktreeId: 'wt-1',
        language: 'typescript',
        mode: 'edit',
        isDirty: false,
        isPreview: false,
        content: '',
        originalContent: ''
      },
      {
        filePath: '/tmp/demo.diff',
        relativePath: 'demo.diff',
        worktreeId: 'wt-1',
        language: 'diff',
        mode: 'diff',
        isDirty: false,
        isPreview: false,
        content: '',
        originalContent: ''
      }
    ],
    activeFileIdByWorktree: { 'wt-1': '/tmp/demo.ts' },
    activeTabTypeByWorktree: { 'wt-1': 'editor', 'wt-2': 'terminal' },
    browserTabsByWorktree: {
      'wt-1': [
        {
          id: 'browser-1',
          url: 'https://example.com',
          title: 'Example',
          loading: true,
          canGoBack: false,
          canGoForward: false,
          errorCode: null,
          errorDescription: null
        }
      ]
    },
    activeBrowserTabIdByWorktree: { 'wt-1': 'browser-1' },
    ...overrides
  } as AppState
}

describe('buildWorkspaceSessionPayload', () => {
  it('preserves activeWorktreeIdsOnShutdown for full replacement writes', () => {
    const payload = buildWorkspaceSessionPayload(createSnapshot())

    expect(payload.activeWorktreeIdsOnShutdown).toEqual(['wt-1'])
  })

  it('persists only edit-mode files and resets browser loading state', () => {
    const payload = buildWorkspaceSessionPayload(createSnapshot())

    expect(payload.openFilesByWorktree).toEqual({
      'wt-1': [
        {
          filePath: '/tmp/demo.ts',
          relativePath: 'demo.ts',
          worktreeId: 'wt-1',
          language: 'typescript',
          isPreview: undefined
        }
      ]
    })
    expect(payload.browserTabsByWorktree?.['wt-1'][0].loading).toBe(false)
  })
})
