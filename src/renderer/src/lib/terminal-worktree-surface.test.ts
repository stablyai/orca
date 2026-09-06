import { describe, expect, it } from 'vitest'
import type { AppState } from '@/store/types'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../shared/constants'
import { brandEphemeralSetupTerminalWorktreeId } from '../../../shared/ephemeral-setup-terminal-worktree-id'
import { folderWorkspaceKey } from '../../../shared/workspace-scope'
import { hasRenderableTerminalWorktreeSurface } from './terminal-worktree-route'

function state(overrides: Partial<AppState> = {}): AppState {
  return {
    repos: [{ id: 'repo-1', executionHostId: 'local' }],
    worktreesByRepo: {
      'repo-1': [{ id: 'repo-1::/workspace', repoId: 'repo-1', path: '/workspace' }]
    },
    folderWorkspaces: [],
    ...overrides
  } as unknown as AppState
}

describe('hasRenderableTerminalWorktreeSurface', () => {
  it('accepts an exact workbench row for local, SSH, and paired runtime worktrees', () => {
    for (const hostId of ['local', 'ssh:connection', 'runtime:hub']) {
      const store = state({
        worktreesByRepo: {
          'repo-1': [{ id: 'repo-1::/workspace', repoId: 'repo-1', hostId }]
        }
      } as unknown as Partial<AppState>)
      expect(hasRenderableTerminalWorktreeSurface(store, 'repo-1::/workspace')).toBe(true)
    }
  })

  it('rejects a hidden detected worktree even when its repo is registered', () => {
    const store = state({
      detectedWorktreesByRepo: {
        'repo-1': { worktrees: [{ id: 'repo-1::/external', repoId: 'repo-1' }] }
      }
    } as unknown as Partial<AppState>)
    expect(hasRenderableTerminalWorktreeSurface(store, 'repo-1::/external')).toBe(false)
  })

  it('rejects a duplicate repo registration id that shares a rendered path', () => {
    const store = state({
      repos: [{ id: 'repo-1' }, { id: 'duplicate-repo' }]
    } as unknown as Partial<AppState>)
    expect(hasRenderableTerminalWorktreeSurface(store, 'duplicate-repo::/workspace')).toBe(false)
  })

  it('accepts an imported worktree once its exact row reaches the workbench catalog', () => {
    const store = state()
    const worktreeId = 'repo-1::/external'
    expect(hasRenderableTerminalWorktreeSurface(store, worktreeId)).toBe(false)
    const imported = state({
      worktreesByRepo: {
        ...store.worktreesByRepo,
        'repo-1': [...store.worktreesByRepo['repo-1'], { id: worktreeId, repoId: 'repo-1' }]
      }
    } as unknown as Partial<AppState>)
    expect(hasRenderableTerminalWorktreeSurface(imported, worktreeId)).toBe(true)
  })

  it('requires a real folder workspace rather than a syntactically valid key', () => {
    const store = state({
      folderWorkspaces: [{ id: 'folder-1', folderPath: '/folder' }]
    } as unknown as Partial<AppState>)
    expect(hasRenderableTerminalWorktreeSurface(store, folderWorkspaceKey('folder-1'))).toBe(true)
    expect(hasRenderableTerminalWorktreeSurface(store, folderWorkspaceKey('missing'))).toBe(false)
  })

  it('preserves the separately hosted floating terminal surface', () => {
    expect(hasRenderableTerminalWorktreeSurface(state(), FLOATING_TERMINAL_WORKTREE_ID)).toBe(true)
  })

  it('rejects inline setup ids whose components only render their own created tab', () => {
    const id = brandEphemeralSetupTerminalWorktreeId('settings-cli-skill-terminal')
    expect(hasRenderableTerminalWorktreeSurface(state(), id)).toBe(false)
  })

  it('fails closed for missing ids or unhydrated catalogs', () => {
    for (const id of [null, undefined, '', 'repo-1::/workspace']) {
      expect(hasRenderableTerminalWorktreeSurface({} as AppState, id)).toBe(false)
    }
  })
})
