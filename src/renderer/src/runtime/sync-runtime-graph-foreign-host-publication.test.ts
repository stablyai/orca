import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ExecutionHostId } from '../../../shared/execution-host'
import type { RuntimeRendererSyncWindowGraph } from '../../../shared/runtime-types'
import { toRemoteRuntimePtyId } from '../../../shared/remote-runtime-pty-id'
import type { OpenFile } from '../store/slices/editor'
import {
  buildMobileSessionTabSnapshots,
  registerRuntimeTerminalTab,
  setRuntimeGraphStoreStateGetter,
  setRuntimeGraphSyncEnabled
} from './sync-runtime-graph'
import { syncRuntimeGraph } from './sync-runtime-graph/graph-publication'
import { makeState } from './sync-runtime-graph-test-harness'
import { captureWorktreeOperationGenerationSnapshot } from '../lib/worktree-operation-generation'
import { applyWebSessionTabsSnapshot } from './web-session-tabs-sync'
import { makeSnapshot, makeState as makeMirrorState } from './web-session-tabs-sync-test-harness'

const workspaceId = 'host-publication-workspace'
const leafId = '11111111-1111-4111-8111-111111111111'

afterEach(() => {
  setRuntimeGraphSyncEnabled(false)
  setRuntimeGraphStoreStateGetter(null)
  vi.unstubAllGlobals()
})

function editor(runtimeEnvironmentId?: string): OpenFile {
  return {
    id: 'host-publication-editor',
    filePath: '/repo/README.md',
    relativePath: 'README.md',
    worktreeId: workspaceId,
    language: 'markdown',
    isDirty: false,
    mode: 'edit',
    runtimeEnvironmentId
  }
}

function terminalState(executionHostId: ExecutionHostId, ptyId: string | null = null) {
  return makeState({
    tabsByWorktree: {
      [workspaceId]: [
        {
          id: 'host-publication-terminal',
          ptyId,
          worktreeId: workspaceId,
          title: 'Terminal',
          customTitle: null,
          color: null,
          sortOrder: 0,
          createdAt: 1
        }
      ]
    },
    unifiedTabsByWorktree: {
      [workspaceId]: [
        {
          id: 'host-publication-terminal',
          entityId: 'host-publication-terminal',
          worktreeId: workspaceId,
          groupId: 'host-publication-group',
          executionHostId,
          contentType: 'terminal',
          label: 'Terminal',
          customLabel: null,
          color: null,
          sortOrder: 0,
          createdAt: 1
        }
      ]
    },
    terminalLayoutsByTabId: {
      'host-publication-terminal': {
        root: { type: 'leaf', leafId },
        activeLeafId: leafId,
        expandedLeafId: null,
        ...(ptyId ? { ptyIdsByLeafId: { [leafId]: ptyId } } : {})
      }
    }
  })
}

describe('local host session publication', () => {
  it.each(['hub-a', 'hub-b'])(
    'does not advertise an SSH editor reached through %s',
    (environmentId) => {
      const file = {
        ...editor(),
        operationProvenance: {
          ownershipProjection: 'explicit' as const,
          generation: captureWorktreeOperationGenerationSnapshot({
            executionHostId: 'ssh:target',
            runtimeEnvironmentId: environmentId
          })
        }
      }
      expect(
        buildMobileSessionTabSnapshots(makeState({ openFiles: [file] })).flatMap(
          (snapshot) => snapshot.tabs
        )
      ).toEqual([])
    }
  )

  it('publishes a captured direct SSH editor despite stale runtime metadata', () => {
    const file = {
      ...editor('stale-hub'),
      operationProvenance: {
        ownershipProjection: 'explicit' as const,
        generation: captureWorktreeOperationGenerationSnapshot({
          executionHostId: 'ssh:target',
          runtimeEnvironmentId: null
        })
      }
    }
    expect(
      buildMobileSessionTabSnapshots(makeState({ openFiles: [file] })).flatMap(
        (snapshot) => snapshot.tabs
      )
    ).toHaveLength(1)
  })

  it('does not advertise a foreign runtime editor as a local file', () => {
    const state = makeState({ openFiles: [editor('wsl-owner')] })
    expect(buildMobileSessionTabSnapshots(state).flatMap((snapshot) => snapshot.tabs)).toEqual([])
  })

  it('cannot turn a correctly owned editor into another host’s file on a second client', () => {
    const file = editor('wsl-owner')
    const publication = buildMobileSessionTabSnapshots(makeState({ openFiles: [file] }))[0]!
    const editorTabs = publication.tabs.filter(
      (tab) => tab.type === 'file' || tab.type === 'markdown'
    )
    const initial = makeMirrorState({ activeWorktreeId: workspaceId })
    const ownedSnapshot = makeSnapshot(
      [
        {
          type: 'file',
          id: 'owned-wsl-editor',
          title: 'README.md',
          filePath: file.filePath,
          relativePath: file.relativePath,
          language: file.language,
          mode: 'edit',
          isDirty: false,
          isActive: true
        }
      ],
      { worktree: workspaceId }
    )
    const owned = {
      ...initial,
      ...applyWebSessionTabsSnapshot(initial, ownedSnapshot, 'wsl-owner')
    }
    const updated = {
      ...owned,
      ...applyWebSessionTabsSnapshot(
        owned,
        makeSnapshot(editorTabs, { worktree: workspaceId }),
        'mac-owner'
      )
    }
    expect(updated.openFiles.map((entry) => entry.runtimeEnvironmentId)).toEqual(['wsl-owner'])
    expect(
      updated.unifiedTabsByWorktree[ownedSnapshot.worktree]?.map((tab) => tab.executionHostId)
    ).toEqual(['runtime:wsl-owner'])
  })

  it('does not advertise a cold foreign runtime terminal as local pending work', () => {
    const state = terminalState('runtime:wsl-owner')
    expect(buildMobileSessionTabSnapshots(state).flatMap((snapshot) => snapshot.tabs)).toEqual([])
  })

  it.each([true, false])(
    'withholds contradictory terminal owners in either row order (%s)',
    (reverse) => {
      const state = terminalState('runtime:wsl-owner')
      const original = state.unifiedTabsByWorktree[workspaceId]![0]!
      const rows = [
        original,
        { ...original, id: 'legacy-local-alias', executionHostId: 'local' as const }
      ]
      state.unifiedTabsByWorktree = { [workspaceId]: reverse ? rows.toReversed() : rows }

      expect(buildMobileSessionTabSnapshots(state).flatMap((snapshot) => snapshot.tabs)).toEqual([])
      expect(state.tabsByWorktree[workspaceId]).toHaveLength(1)
    }
  )

  it('withholds a legacy editor whose canonical tab proves a foreign owner', () => {
    const file = editor()
    const state = terminalState('local')
    const terminalTab = state.unifiedTabsByWorktree[workspaceId]![0]!
    state.tabsByWorktree = {}
    state.openFiles = [file]
    state.unifiedTabsByWorktree = {
      [workspaceId]: [
        {
          ...terminalTab,
          id: file.id,
          entityId: file.id,
          executionHostId: 'runtime:wsl-owner',
          contentType: 'editor'
        }
      ]
    }
    expect(buildMobileSessionTabSnapshots(state).flatMap((snapshot) => snapshot.tabs)).toEqual([])
    expect(state.openFiles).toEqual([file])
  })

  it('does not advertise a legacy foreign PTY without a mirrored-tab prefix', () => {
    const state = terminalState('local', toRemoteRuntimePtyId('terminal-handle', 'wsl-owner'))
    expect(buildMobileSessionTabSnapshots(state).flatMap((snapshot) => snapshot.tabs)).toEqual([])
  })

  it('still advertises local editors and cold terminals', () => {
    expect(
      buildMobileSessionTabSnapshots(makeState({ openFiles: [editor()] })).flatMap(
        (snapshot) => snapshot.tabs
      )
    ).toHaveLength(1)
    expect(
      buildMobileSessionTabSnapshots(terminalState('local')).flatMap((snapshot) => snapshot.tabs)
    ).toHaveLength(1)
  })

  it('still advertises direct SSH terminals owned through this host', () => {
    expect(
      buildMobileSessionTabSnapshots(terminalState('ssh:ssh-target', 'ssh-pty-1')).flatMap(
        (snapshot) => snapshot.tabs
      )
    ).toHaveLength(1)
  })

  it('still advertises direct SSH editors', () => {
    const file = { ...editor(), externalSshTargetId: 'ssh-target' }
    expect(
      buildMobileSessionTabSnapshots(makeState({ openFiles: [file] })).flatMap(
        (snapshot) => snapshot.tabs
      )
    ).toHaveLength(1)
  })

  it('filters foreign editors in live folder workspaces without changing their drafts', () => {
    const folderKey = 'folder:host-publication-folder'
    const file = { ...editor('wsl-owner'), worktreeId: folderKey, isDirty: true }
    const drafts = { [file.id]: 'unsaved work on the WSL host' }
    const state = makeState({
      openFiles: [file],
      editorDrafts: drafts,
      folderWorkspaces: [
        {
          id: 'host-publication-folder',
          projectGroupId: 'group',
          name: 'Folder',
          folderPath: '/repo',
          linkedTask: null,
          comment: '',
          isArchived: false,
          isUnread: false,
          isPinned: false,
          sortOrder: 0,
          lastActivityAt: 1,
          createdAt: 1,
          updatedAt: 1
        }
      ]
    })
    const snapshots = buildMobileSessionTabSnapshots(state)
    expect(snapshots).toHaveLength(1)
    expect(snapshots[0]?.worktree).toBe(folderKey)
    expect(snapshots[0]?.tabs).toEqual([])
    expect(state.openFiles).toEqual([file])
    expect(state.editorDrafts).toBe(drafts)
    expect(state.editorDrafts[file.id]).toBe('unsaved work on the WSL host')
    const local = { ...state, openFiles: [{ ...file, runtimeEnvironmentId: null }] }
    expect(buildMobileSessionTabSnapshots(local)[0]?.tabs).toHaveLength(1)
  })

  it('rebuilds the inventory when only the captured terminal owner changes', () => {
    const local = terminalState('local')
    const initial = buildMobileSessionTabSnapshots(local)[0]!
    const foreign = {
      ...local,
      unifiedTabsByWorktree: terminalState('runtime:wsl-owner').unifiedTabsByWorktree
    }
    const changed = buildMobileSessionTabSnapshots(foreign)[0]!
    expect(initial.tabs).toHaveLength(1)
    expect(changed.tabs).toEqual([])
    expect(changed.snapshotVersion).toBeGreaterThan(initial.snapshotVersion)
  })

  it.each(['local', 'runtime:wsl-owner', 'ssh:ssh-target'] as const)(
    'publishes mounted graph authority only for local-managed %s terminals',
    async (owner) => {
      const graphs: RuntimeRendererSyncWindowGraph[] = []
      vi.stubGlobal('HTMLElement', class HTMLElement {})
      vi.stubGlobal('window', {
        api: {
          runtime: {
            syncWindowGraph: async (graph: RuntimeRendererSyncWindowGraph) => {
              graphs.push(graph)
              return {}
            }
          }
        }
      })
      const state = terminalState(owner)
      setRuntimeGraphStoreStateGetter(() => state)
      setRuntimeGraphSyncEnabled(true)
      const unregister = registerRuntimeTerminalTab({
        tabId: 'host-publication-terminal',
        worktreeId: workspaceId,
        getManager: () => null,
        getContainer: () => null,
        getPtyIdForPane: () => null,
        getTabWideAgentHintLeafId: () => null
      })
      try {
        await syncRuntimeGraph()
        expect(graphs).toHaveLength(1)
        expect(graphs[0]?.tabs).toHaveLength(owner === 'runtime:wsl-owner' ? 0 : 1)
        expect(graphs[0]?.mobileSessionTabs?.flatMap((snapshot) => snapshot.tabs)).toHaveLength(
          owner === 'runtime:wsl-owner' ? 0 : 1
        )
      } finally {
        unregister()
      }
    }
  )
})
