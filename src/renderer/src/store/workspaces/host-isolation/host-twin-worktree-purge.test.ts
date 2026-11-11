import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { hostWorktreeTarget } from '../../../../../shared/worktree/host-qualified-identity'
import { getWorktreeVisitKey } from '@/lib/workspace/activation/worktree-visit-recency'
import '@/lib/workspace/sleep/worktree-sleep-intent'
import { resetHostTwinModuleStores } from './host-twin-state-projection.test-fixture'
import { createHostTwinFixture } from './host-twin.test-fixture'
import type { HostTwinFixture } from './host-twin.test-fixture'

vi.mock('sonner', () => ({
  toast: { info: vi.fn(), success: vi.fn(), error: vi.fn(), warning: vi.fn() }
}))

let current: HostTwinFixture | null = null

beforeEach(() => {
  vi.stubGlobal('window', { api: { pty: { kill: vi.fn() } } })
})

afterEach(() => {
  if (current) {
    resetHostTwinModuleStores(current)
  }
  current = null
  vi.unstubAllGlobals()
})

function twin(kind: Parameters<typeof createHostTwinFixture>[0] = 'local+ssh'): HostTwinFixture {
  const fixture = createHostTwinFixture(kind)
  current = fixture
  const key = fixture.workspaceKey
  fixture.store.setState({
    gitStatusByWorktree: { [key]: [] },
    activeWorktreeId: key,
    activeWorkspaceExecutionHostId: fixture.remote.hostId,
    lastVisitedAtByWorktreeId: {
      [getWorktreeVisitKey(key, fixture.local.hostId)]: 1,
      [getWorktreeVisitKey(key, fixture.remote.hostId)]: 2
    }
  })
  return fixture
}

describe('purgeWorktreeTerminalState with a surviving twin', () => {
  it('keeps PTY-keyed state for a purged PTY that a kept tab still binds', () => {
    const f = twin()
    const shared = f.remote.ptyId
    // A mixed-host split: the kept local tab also binds the purged copy's PTY.
    f.store.setState((s) => ({
      ptyIdsByTabId: { ...s.ptyIdsByTabId, [f.local.terminalTabId]: [f.local.ptyId, shared] },
      suppressedPtyExitIds: { [shared]: true },
      pendingPaneAccountRestarts: { [shared]: 'codex' }
    }))

    f.store
      .getState()
      .purgeWorktreeTerminalState([hostWorktreeTarget({ id: f.workspaceKey, ...f.remote })])

    const s = f.store.getState()
    expect(s.ptyIdsByTabId[f.local.terminalTabId]).toEqual([f.local.ptyId, shared])
    expect(s.suppressedPtyExitIds).toEqual({ [shared]: true })
    expect(s.pendingPaneAccountRestarts).toEqual({ [shared]: 'codex' })
  })

  it('selects a surviving tab when the purged terminal was active', () => {
    const f = twin()
    const key = f.workspaceKey
    f.store.setState((s) => ({
      activeTabId: f.remote.terminalTabId,
      activeTabType: 'terminal',
      groupsByWorktree: {
        [key]: (s.groupsByWorktree[key] ?? []).map((group) => ({
          ...group,
          activeTabId: f.remote.terminalTabId,
          recentTabIds: [f.local.fileId, f.remote.terminalTabId]
        }))
      }
    }))

    f.store.getState().purgeWorktreeTerminalState([hostWorktreeTarget({ id: key, ...f.remote })])

    const s = f.store.getState()
    expect(s.groupsByWorktree[key]?.[0]?.activeTabId).toBe(f.local.fileId)
    expect(s.activeTabType).toBe('editor')
    expect(s.activeFileId).toBe(f.local.fileId)
  })

  it.each([
    ['drops', 'remote-source.md', 'local-source.md', false],
    ['keeps', 'shared-source.md', 'shared-source.md', true]
  ] as const)(
    "%s a purged preview's source state by whether a surviving file still uses it",
    (_verb, remoteSource, localSource, kept) => {
      const f = twin()
      const key = f.workspaceKey
      f.store.setState((s) => ({
        openFiles: s.openFiles.map((file) => ({
          ...file,
          markdownPreviewSourceFileId: file.id === f.remote.fileId ? remoteSource : localSource
        })),
        editorDrafts: { ...s.editorDrafts, [remoteSource]: 'source draft' }
      }))

      f.store.getState().purgeWorktreeTerminalState([hostWorktreeTarget({ id: key, ...f.remote })])

      expect(remoteSource in f.store.getState().editorDrafts).toBe(kept)
      expect(f.store.getState().editorDrafts[f.local.fileId]).toBeDefined()
    }
  )
})
