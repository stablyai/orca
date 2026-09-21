import { beforeEach, describe, expect, it, vi } from 'vitest'
import { posix as pathPosix } from 'node:path'
import type { RuntimeMobileSessionTabsResult } from '../../../shared/runtime-types'
import type { TerminalTab } from '../../../shared/terminal-tab-types'
import type { OpenFile } from '../store/slices/editor'
import {
  applyWebSessionTabsSnapshot,
  applyWebSessionTabsSnapshots,
  resetWebSessionTabsSnapshotFreshnessForTests,
  type WebSessionTabsSyncState
} from './web-session-tabs-sync'
import {
  ENV,
  HOST_SURFACE_ID,
  LEAF_ID,
  NOW,
  SECOND_LEAF_ID,
  THIRD_LEAF_ID,
  WT,
  makeSnapshot,
  makeState,
  resetWebSessionTabsSyncTestState
} from './web-session-tabs-sync-test-harness'

vi.mock('../store', () => ({
  useAppStore: {
    setState: vi.fn()
  }
}))

describe('applyWebSessionTabsSnapshot', () => {
  beforeEach(resetWebSessionTabsSyncTestState)

  it('hydrates multiple initial host snapshots in one merged patch', () => {
    const secondWorktree = 'repo::/other-worktree'
    const patch = applyWebSessionTabsSnapshots(
      makeState({ activeWorktreeId: null }),
      [
        makeSnapshot([
          {
            type: 'terminal',
            id: HOST_SURFACE_ID,
            title: 'host shell',
            parentTabId: 'host-tab-1',
            leafId: LEAF_ID,
            isActive: true,
            status: 'ready',
            terminal: 'terminal-1'
          }
        ]),
        makeSnapshot(
          [
            {
              type: 'terminal',
              id: `host-tab-2::${SECOND_LEAF_ID}`,
              title: 'second shell',
              parentTabId: 'host-tab-2',
              leafId: SECOND_LEAF_ID,
              isActive: true,
              status: 'ready',
              terminal: 'terminal-2'
            }
          ],
          { worktree: secondWorktree, activeGroupId: 'host-group-2' }
        )
      ],
      ENV,
      NOW
    ) as Partial<WebSessionTabsSyncState>

    expect(patch.tabsByWorktree?.[WT]).toHaveLength(1)
    expect(patch.tabsByWorktree?.[secondWorktree]).toHaveLength(1)
    expect(patch.ptyIdsByTabId).toEqual(
      expect.objectContaining({
        [patch.tabsByWorktree?.[WT]?.[0]?.id ?? '']: ['remote:web-env-1@@terminal-1'],
        [patch.tabsByWorktree?.[secondWorktree]?.[0]?.id ?? '']: ['remote:web-env-1@@terminal-2']
      })
    )
  })

  it('keeps an empty snapshot batch as an identity no-op', () => {
    const state = makeState()
    expect(applyWebSessionTabsSnapshots(state, [], ENV, NOW)).toBe(state)
  })

  it('matches sequential reconciliation across duplicate-worktree mixed snapshots', () => {
    const secondWorktree = 'repo::/other-worktree'
    const snapshots: RuntimeMobileSessionTabsResult[] = [
      makeSnapshot([
        {
          type: 'terminal',
          id: HOST_SURFACE_ID,
          title: 'first agent',
          parentTabId: 'host-tab-1',
          leafId: LEAF_ID,
          isActive: true,
          status: 'ready',
          terminal: 'terminal-1',
          agentStatus: {
            state: 'working',
            prompt: 'first task',
            updatedAt: NOW,
            stateStartedAt: NOW,
            agentType: 'codex',
            paneKey: HOST_SURFACE_ID,
            stateHistory: []
          }
        }
      ]),
      makeSnapshot(
        [
          {
            type: 'browser',
            id: 'host-browser-unified',
            title: 'Example Domain',
            browserWorkspaceId: 'host-browser-workspace',
            browserPageId: 'host-browser-page',
            url: 'https://example.com/',
            loading: false,
            canGoBack: false,
            canGoForward: false,
            isActive: true
          }
        ],
        {
          worktree: secondWorktree,
          activeGroupId: 'host-group-2',
          activeTabId: 'host-browser-unified',
          activeTabType: 'browser'
        }
      ),
      makeSnapshot([], {
        snapshotVersion: 2,
        activeGroupId: null,
        activeTabId: null,
        activeTabType: null
      }),
      makeSnapshot(
        [
          {
            type: 'terminal',
            id: `host-tab-3::${THIRD_LEAF_ID}`,
            title: 'replacement agent',
            parentTabId: 'host-tab-3',
            leafId: THIRD_LEAF_ID,
            isActive: true,
            status: 'ready',
            terminal: 'terminal-3',
            agentStatus: {
              state: 'waiting',
              prompt: 'replacement question',
              updatedAt: NOW + 1,
              stateStartedAt: NOW + 1,
              agentType: 'codex',
              paneKey: `host-tab-3::${THIRD_LEAF_ID}`,
              stateHistory: []
            }
          }
        ],
        { snapshotVersion: 3 }
      ),
      makeSnapshot(
        [
          {
            type: 'markdown',
            id: 'host-readme-unified',
            title: 'README.md',
            filePath: '/repo/README.md',
            relativePath: 'README.md',
            language: 'markdown',
            mode: 'edit',
            isDirty: false,
            isActive: true,
            sourceFileId: '/repo/README.md',
            sourceFilePath: '/repo/README.md',
            sourceRelativePath: 'README.md',
            documentVersion: 'file:/repo/README.md'
          }
        ],
        {
          worktree: secondWorktree,
          snapshotVersion: 2,
          activeGroupId: 'host-group-2',
          activeTabId: 'host-readme-unified',
          activeTabType: 'markdown'
        }
      )
    ]
    const provisionalTab: TerminalTab = {
      id: 'host-tab-1',
      ptyId: null,
      worktreeId: WT,
      title: 'Codex',
      defaultTitle: 'Codex',
      customTitle: null,
      color: null,
      sortOrder: 0,
      createdAt: NOW,
      launchAgent: 'codex'
    }
    const initial = makeState({
      activeWorktreeId: null,
      tabsByWorktree: { [WT]: [provisionalTab] },
      pendingStartupByTabId: {
        [provisionalTab.id]: { command: 'codex' }
      },
      automaticAgentResumeClaimsByTabId: {
        [provisionalTab.id]: {
          worktreeId: WT,
          launchAgent: 'codex',
          providerSession: { key: 'session_id', id: 'session-a' }
        }
      }
    })
    const initialCopy = structuredClone(initial)
    let sequential = initial
    for (const snapshot of snapshots) {
      const patch = applyWebSessionTabsSnapshot(sequential, snapshot, ENV, NOW)
      if (patch !== sequential) {
        sequential = { ...sequential, ...patch }
      }
    }

    resetWebSessionTabsSnapshotFreshnessForTests()
    const batchPatch = applyWebSessionTabsSnapshots(initial, snapshots, ENV, NOW)
    const batched = { ...initial, ...batchPatch }

    expect(batched).toEqual(sequential)
    expect(initial).toEqual(initialCopy)
  })

  it('matches sequential open-file reconciliation across an editor-heavy batch', () => {
    const secondWorktree = 'repo::/other-worktree'
    const editorSurface = (
      id: string,
      path: string,
      overrides: { isDirty?: boolean } = {}
    ): RuntimeMobileSessionTabsResult['tabs'][number] =>
      ({
        type: 'file',
        id,
        title: pathPosix.basename(path),
        filePath: path,
        relativePath: path.replace(/^\/repo\//, ''),
        language: 'typescript',
        isDirty: overrides.isDirty ?? false,
        isActive: true
      }) as RuntimeMobileSessionTabsResult['tabs'][number]
    const mirroredFile = (path: string, worktree: string): OpenFile =>
      ({
        id: path,
        filePath: path,
        relativePath: path.replace(/^\/repo\//, ''),
        worktreeId: worktree,
        language: 'typescript',
        isDirty: false,
        runtimeEnvironmentId: ENV,
        mode: 'edit',
        mirroredFromRuntimeSession: true
      }) as OpenFile
    const initial = makeState({
      activeWorktreeId: WT,
      activeFileId: '/repo/a.ts',
      activeFileIdByWorktree: { [WT]: '/repo/a.ts' },
      openFiles: [
        // Why: a bystander worktree's files must keep their positions through the batch.
        mirroredFile('/repo/bystander-1.ts', 'repo::/bystander'),
        mirroredFile('/repo/a.ts', WT),
        // Why: locally opened (not host-mirrored) files must survive a host omission.
        {
          ...mirroredFile('/repo/local-only.ts', WT),
          mirroredFromRuntimeSession: false
        } as OpenFile,
        // Why: same (worktree, id) as a mirrored file but a different environment —
        // the duplicate case that makes the first-wins lookup observable.
        {
          ...mirroredFile('/repo/a.ts', WT),
          runtimeEnvironmentId: 'other-env'
        } as OpenFile,
        mirroredFile('/repo/dropped.ts', WT),
        mirroredFile('/repo/bystander-2.ts', 'repo::/bystander'),
        mirroredFile('/repo/second.ts', secondWorktree)
      ]
    })
    const snapshots: RuntimeMobileSessionTabsResult[] = [
      // Drops /repo/dropped.ts and flips a.ts dirty.
      makeSnapshot([editorSurface('host-a', '/repo/a.ts', { isDirty: true })], {
        activeTabId: 'host-a',
        activeTabType: 'file'
      }),
      makeSnapshot([editorSurface('host-second', '/repo/second.ts')], {
        worktree: secondWorktree,
        activeGroupId: 'host-group-2',
        activeTabId: 'host-second',
        activeTabType: 'file'
      }),
      // Same worktree again: adds a file, so the batch must see snapshot 1's result.
      makeSnapshot(
        [
          editorSurface('host-a', '/repo/a.ts', { isDirty: true }),
          editorSurface('host-b', '/repo/b.ts')
        ],
        { snapshotVersion: 2, activeTabId: 'host-b', activeTabType: 'file' }
      ),
      // Host drops every editor for the second worktree.
      makeSnapshot([], {
        worktree: secondWorktree,
        snapshotVersion: 2,
        activeGroupId: null,
        activeTabId: null,
        activeTabType: null
      })
    ]
    const initialCopy = structuredClone(initial)

    let sequential = initial
    for (const snapshot of snapshots) {
      const patch = applyWebSessionTabsSnapshot(sequential, snapshot, ENV, NOW)
      if (patch !== sequential) {
        sequential = { ...sequential, ...patch }
      }
    }

    resetWebSessionTabsSnapshotFreshnessForTests()
    const batched = {
      ...initial,
      ...applyWebSessionTabsSnapshots(initial, snapshots, ENV, NOW)
    }

    expect(batched.openFiles).toEqual(sequential.openFiles)
    expect(batched).toEqual(sequential)
    expect(initial).toEqual(initialCopy)
    // Pin the observable outcomes rather than only cross-checking the two paths.
    expect(batched.openFiles.map((file) => file.id)).toEqual([
      '/repo/bystander-1.ts',
      '/repo/local-only.ts',
      '/repo/a.ts',
      '/repo/bystander-2.ts',
      '/repo/a.ts',
      '/repo/b.ts'
    ])
    expect(
      batched.openFiles.find(
        (file) => file.id === '/repo/a.ts' && file.runtimeEnvironmentId === 'other-env'
      )
    ).toBeDefined()
    expect(batched.openFiles.some((file) => file.id === '/repo/dropped.ts')).toBe(false)
    expect(batched.openFiles.some((file) => file.id === '/repo/second.ts')).toBe(false)
  })

  it('seeds a mirrored editor file from the first duplicate open file, as find() did', () => {
    // Why: two entries share (worktree, id) and differ only in a field the mirrored
    // file inherits, so which duplicate seeds the spread is observable.
    const duplicate = (signature: string, environmentId: string | null): OpenFile =>
      ({
        id: '/repo/dup.ts',
        filePath: '/repo/dup.ts',
        relativePath: 'dup.ts',
        worktreeId: WT,
        language: 'typescript',
        isDirty: false,
        runtimeEnvironmentId: environmentId,
        mode: 'edit',
        mirroredFromRuntimeSession: true,
        lastKnownDiskSignature: signature
      }) as OpenFile
    const snapshot = makeSnapshot(
      [
        {
          type: 'file',
          id: 'host-dup',
          title: 'dup.ts',
          filePath: '/repo/dup.ts',
          relativePath: 'dup.ts',
          language: 'typescript',
          // Why: a compared field must differ, or the reconciled array is equal and
          // the patch is suppressed before the inherited signature is observable.
          isDirty: true,
          isActive: true
        } as RuntimeMobileSessionTabsResult['tabs'][number]
      ],
      { activeTabId: 'host-dup', activeTabType: 'file' }
    )

    for (const label of ['single', 'batch'] as const) {
      resetWebSessionTabsSnapshotFreshnessForTests()
      const state = makeState({
        openFiles: [duplicate('winner', 'other-env'), duplicate('loser', ENV)]
      })
      const patch = (
        label === 'single'
          ? applyWebSessionTabsSnapshot(state, snapshot, ENV, NOW)
          : applyWebSessionTabsSnapshots(state, [snapshot], ENV, NOW)
      ) as Partial<WebSessionTabsSyncState>
      const mirrored = patch.openFiles?.find(
        (file) => file.id === '/repo/dup.ts' && file.runtimeEnvironmentId === ENV
      )
      expect(mirrored?.lastKnownDiskSignature, label).toBe('winner')
    }
  })

  it('keeps the editor pane visible when the host republishes the active editor file', () => {
    // Why: the active file is re-mirrored, so it leaves the surviving set as a
    // replaced id and must come back as a mirrored id — otherwise focus falls
    // through to the terminal on every reconnect.
    const activeFile = {
      id: '/repo/focused.ts',
      filePath: '/repo/focused.ts',
      relativePath: 'focused.ts',
      worktreeId: WT,
      language: 'typescript',
      isDirty: false,
      runtimeEnvironmentId: ENV,
      mode: 'edit',
      mirroredFromRuntimeSession: true
    } as OpenFile
    const snapshot = makeSnapshot(
      [
        {
          type: 'terminal',
          id: HOST_SURFACE_ID,
          title: 'host shell',
          parentTabId: 'host-tab-1',
          leafId: LEAF_ID,
          isActive: true,
          status: 'ready',
          terminal: 'terminal-1'
        },
        {
          type: 'file',
          id: 'host-focused',
          title: 'focused.ts',
          filePath: '/repo/focused.ts',
          relativePath: 'focused.ts',
          language: 'typescript',
          isDirty: false,
          isActive: false
        } as RuntimeMobileSessionTabsResult['tabs'][number]
      ],
      { activeTabId: HOST_SURFACE_ID, activeTabType: 'terminal' }
    )

    for (const label of ['single', 'batch'] as const) {
      resetWebSessionTabsSnapshotFreshnessForTests()
      const state = makeState({
        activeWorktreeId: WT,
        activeFileId: activeFile.id,
        activeFileIdByWorktree: { [WT]: activeFile.id },
        activeTabTypeByWorktree: { [WT]: 'editor' },
        activeTabType: 'editor',
        openFiles: [activeFile]
      })
      const patch = (
        label === 'single'
          ? applyWebSessionTabsSnapshot(state, snapshot, ENV, NOW)
          : applyWebSessionTabsSnapshots(state, [snapshot], ENV, NOW)
      ) as Partial<WebSessionTabsSyncState>
      const nextTabType = patch.activeTabTypeByWorktree?.[WT] ?? state.activeTabTypeByWorktree[WT]
      expect(nextTabType, label).toBe('editor')
      expect(patch.activeFileIdByWorktree?.[WT] ?? state.activeFileIdByWorktree[WT], label).toBe(
        activeFile.id
      )
    }
  })

  it('rebuilds an open file the batch closed and reopened, as sequential does', () => {
    // Why: a batch whose net effect is openFileEqual to its input must still adopt the
    // rebuilt file. Deferring the equality check to the end of the batch would keep the
    // pre-batch object and its per-file state (autosave gates, disk signature).
    const beforeBatch = {
      id: '/repo/a.ts',
      filePath: '/repo/a.ts',
      relativePath: 'a.ts',
      worktreeId: WT,
      language: 'typescript',
      isDirty: false,
      runtimeEnvironmentId: ENV,
      mode: 'edit',
      mirroredFromRuntimeSession: true,
      lastKnownDiskSignature: 'stale-signature'
    } as OpenFile
    const editorSnapshot = (path: string, version: number): RuntimeMobileSessionTabsResult =>
      makeSnapshot(
        [
          {
            type: 'file',
            id: `host-${path}`,
            title: path,
            filePath: path,
            relativePath: path.slice('/repo/'.length),
            language: 'typescript',
            isDirty: false,
            isActive: true
          } as RuntimeMobileSessionTabsResult['tabs'][number]
        ],
        { snapshotVersion: version, activeTabId: `host-${path}`, activeTabType: 'file' }
      )
    // Closes a.ts, then reopens it — net content is equal, but the object is new.
    const snapshots = [editorSnapshot('/repo/b.ts', 1), editorSnapshot('/repo/a.ts', 2)]
    const state = makeState({ openFiles: [beforeBatch] })

    resetWebSessionTabsSnapshotFreshnessForTests()
    let sequential = state
    for (const snapshot of snapshots) {
      const patch = applyWebSessionTabsSnapshot(sequential, snapshot, ENV, NOW)
      if (patch !== sequential) {
        sequential = { ...sequential, ...patch }
      }
    }

    resetWebSessionTabsSnapshotFreshnessForTests()
    const batched = { ...state, ...applyWebSessionTabsSnapshots(state, snapshots, ENV, NOW) }

    expect(batched.openFiles).toEqual(sequential.openFiles)
    expect(batched.openFiles.map((file) => file.id)).toEqual(['/repo/a.ts'])
    expect(batched.openFiles[0]?.lastKnownDiskSignature).toBeUndefined()
  })

  it('keeps the matching-environment duplicate when a batch rebuild is a no-op', () => {
    // Why: the rebuilt file is seeded from the first (worktree, id) match, which here
    // belongs to another environment. When the rebuild changes nothing, the original
    // must survive rather than be swapped for a clone of the other environment's entry.
    const duplicate = (environmentId: string, signature: string): OpenFile =>
      ({
        id: '/repo/b.ts',
        filePath: '/repo/b.ts',
        relativePath: 'b.ts',
        worktreeId: WT,
        language: 'typescript',
        isDirty: false,
        runtimeEnvironmentId: environmentId,
        mode: 'edit',
        mirroredFromRuntimeSession: true,
        lastKnownDiskSignature: signature
      }) as OpenFile
    const state = makeState({
      openFiles: [duplicate('other-env', 'sig-other-env'), duplicate(ENV, 'sig-this-env')]
    })
    const republish = makeSnapshot(
      [
        {
          type: 'file',
          id: 'host-b',
          title: 'b.ts',
          filePath: '/repo/b.ts',
          relativePath: 'b.ts',
          language: 'typescript',
          isDirty: false,
          isActive: true
        } as RuntimeMobileSessionTabsResult['tabs'][number]
      ],
      { activeTabId: 'host-b', activeTabType: 'file' }
    )
    // A second worktree changes, so the batch cannot stay a whole-array no-op.
    const otherWorktree = makeSnapshot(
      [
        {
          type: 'file',
          id: 'host-x',
          title: 'x.ts',
          filePath: '/other/x.ts',
          relativePath: 'x.ts',
          language: 'typescript',
          isDirty: false,
          isActive: true
        } as RuntimeMobileSessionTabsResult['tabs'][number]
      ],
      {
        worktree: 'repo::/other',
        activeGroupId: 'host-group-other',
        activeTabId: 'host-x',
        activeTabType: 'file'
      }
    )
    const snapshots = [republish, otherWorktree]

    resetWebSessionTabsSnapshotFreshnessForTests()
    let sequential = state
    for (const snapshot of snapshots) {
      const patch = applyWebSessionTabsSnapshot(sequential, snapshot, ENV, NOW)
      if (patch !== sequential) {
        sequential = { ...sequential, ...patch }
      }
    }

    resetWebSessionTabsSnapshotFreshnessForTests()
    const batched = { ...state, ...applyWebSessionTabsSnapshots(state, snapshots, ENV, NOW) }

    expect(batched.openFiles).toEqual(sequential.openFiles)
    expect(
      batched.openFiles
        .filter((file) => file.id === '/repo/b.ts')
        .map((file) => file.lastKnownDiskSignature)
    ).toEqual(['sig-other-env', 'sig-this-env'])
  })

  it('keeps another environment’s duplicate active when this environment culls the id', () => {
    // Why: culling is scoped to the publishing environment. A same-id file owned by a
    // different environment survives, so it must still count as the active editor.
    const duplicate = (environmentId: string): OpenFile =>
      ({
        id: '/repo/shared.ts',
        filePath: '/repo/shared.ts',
        relativePath: 'shared.ts',
        worktreeId: WT,
        language: 'typescript',
        isDirty: false,
        runtimeEnvironmentId: environmentId,
        mode: 'edit',
        mirroredFromRuntimeSession: true
      }) as OpenFile
    // Publishes a terminal and no editors, so this environment culls /repo/shared.ts.
    const snapshot = makeSnapshot([
      {
        type: 'terminal',
        id: HOST_SURFACE_ID,
        title: 'host shell',
        parentTabId: 'host-tab-1',
        leafId: LEAF_ID,
        isActive: true,
        status: 'ready',
        terminal: 'terminal-1'
      }
    ])

    for (const label of ['single', 'batch'] as const) {
      resetWebSessionTabsSnapshotFreshnessForTests()
      const state = makeState({
        activeWorktreeId: WT,
        activeFileId: '/repo/shared.ts',
        activeFileIdByWorktree: { [WT]: '/repo/shared.ts' },
        activeTabTypeByWorktree: { [WT]: 'editor' },
        activeTabType: 'editor',
        openFiles: [duplicate('other-env'), duplicate(ENV)]
      })
      const patch = (
        label === 'single'
          ? applyWebSessionTabsSnapshot(state, snapshot, ENV, NOW)
          : applyWebSessionTabsSnapshots(state, [snapshot], ENV, NOW)
      ) as Partial<WebSessionTabsSyncState>
      const nextOpenFiles = patch.openFiles ?? state.openFiles
      expect(
        nextOpenFiles.map((file) => file.runtimeEnvironmentId),
        label
      ).toEqual(['other-env'])
      expect(patch.activeTabTypeByWorktree?.[WT] ?? state.activeTabTypeByWorktree[WT], label).toBe(
        'editor'
      )
    }
  })

  it('keeps a batch that only revisits unchanged open files off the patch', () => {
    const unchanged: OpenFile = {
      id: '/repo/steady.ts',
      filePath: '/repo/steady.ts',
      relativePath: 'steady.ts',
      worktreeId: WT,
      language: 'typescript',
      isDirty: false,
      runtimeEnvironmentId: ENV,
      mode: 'edit',
      mirroredFromRuntimeSession: true
    } as OpenFile
    const state = makeState({ openFiles: [unchanged] })
    const snapshot = makeSnapshot(
      [
        {
          type: 'file',
          id: 'host-steady',
          title: 'steady.ts',
          filePath: '/repo/steady.ts',
          relativePath: 'steady.ts',
          language: 'typescript',
          isDirty: false,
          isActive: true
        } as RuntimeMobileSessionTabsResult['tabs'][number]
      ],
      { activeTabId: 'host-steady', activeTabType: 'file' }
    )

    const patch = applyWebSessionTabsSnapshots(
      state,
      [snapshot],
      ENV,
      NOW
    ) as Partial<WebSessionTabsSyncState>

    expect(Object.hasOwn(patch, 'openFiles')).toBe(false)
    expect(state.openFiles).toEqual([unchanged])
  })
})
