import { afterEach, describe, expect, it } from 'vitest'
import type { AppState } from '@/store'
import type { LastTabAutoDeleteMode } from '../../../../shared/worktree-deletion-preferences'
import {
  captureLastTabAutoDeleteCandidate,
  type LastTabAutoDeleteCandidate
} from './last-tab-auto-delete-candidate'
import { resolveLastTabAutoDeleteTarget } from './last-tab-auto-delete-eligibility'

type WorktreeRow = {
  id: string
  repoId: string
  instanceId?: string
  hostId?: string
  isMainWorktree?: boolean
  isPinned?: boolean
}
type FolderRow = {
  id: string
  projectGroupId: string
  connectionId?: string | null
  executionHostId?: string | null
  isPinned?: boolean
}

function makeState(opts: {
  mode?: LastTabAutoDeleteMode
  skipPinned?: boolean
  skipFolder?: boolean
  skipSsh?: boolean
  worktrees?: WorktreeRow[]
  folders?: FolderRow[]
  groups?: { id: string; connectionId?: string | null; executionHostId?: string | null }[]
  repos?: { id: string; connectionId?: string | null; executionHostId?: string | null }[]
  tabCount?: number
  activeWorktreeId?: string | null
  activeHostId?: string | null
}): AppState {
  const worktreesByRepo: Record<string, unknown[]> = {}
  for (const row of opts.worktrees ?? []) {
    ;(worktreesByRepo[row.repoId] ??= []).push({
      isMainWorktree: false,
      isPinned: false,
      displayName: row.id,
      ...row
    })
  }
  return {
    settings: {
      deleteWorkspaceOnLastTabClose: opts.mode ?? 'close',
      lastTabDeleteSkipPinned: opts.skipPinned ?? true,
      lastTabDeleteSkipFolder: opts.skipFolder ?? false,
      lastTabDeleteSkipSsh: opts.skipSsh ?? false
    },
    worktreesByRepo,
    folderWorkspaces: (opts.folders ?? []).map((row) => ({ isPinned: false, ...row })),
    projectGroups: opts.groups ?? [],
    repos: opts.repos ?? [],
    activeWorktreeId: opts.activeWorktreeId ?? null,
    activeWorkspaceExecutionHostId: opts.activeHostId ?? null,
    reconcileWorktreeTabModel: () => ({ renderableTabCount: opts.tabCount ?? 0 })
  } as unknown as AppState
}

const WT = 'repo::/wt'
const worktree = (extra: Partial<WorktreeRow> = {}): WorktreeRow => ({
  id: WT,
  repoId: 'repo',
  instanceId: 'i1',
  hostId: 'local',
  ...extra
})
const candidate = (
  extra: Partial<LastTabAutoDeleteCandidate> = {}
): LastTabAutoDeleteCandidate => ({
  workspaceKey: WT,
  trigger: 'close',
  wasActive: true,
  hostId: 'local',
  instanceId: 'i1',
  ...extra
})

describe('resolveLastTabAutoDeleteTarget', () => {
  it.each([
    ['off', 'close', true, false],
    ['off', 'exit', true, false],
    ['close', 'close', true, true],
    ['close', 'close', false, true],
    ['close', 'exit', true, false],
    ['close', 'exit', false, false],
    ['close-or-exit', 'exit', true, true],
    ['close-or-exit', 'exit', false, false],
    ['close-or-exit-background', 'exit', true, true],
    ['close-or-exit-background', 'exit', false, true]
  ] as const)('mode %s, trigger %s, active %s → %s', (mode, trigger, wasActive, expected) => {
    const state = makeState({ mode, worktrees: [worktree()] })
    const target = resolveLastTabAutoDeleteTarget(state, candidate({ trigger, wasActive }))
    expect(target !== null).toBe(expected)
  })

  it('reads an unknown mode as off', () => {
    const state = makeState({ worktrees: [worktree()] })
    ;(state.settings as { deleteWorkspaceOnLastTabClose: string }).deleteWorkspaceOnLastTabClose =
      'always'
    expect(resolveLastTabAutoDeleteTarget(state, candidate())).toBeNull()
    expect(captureLastTabAutoDeleteCandidate(state, WT, { trigger: 'close' })).toBeNull()
  })

  it('never deletes the main worktree', () => {
    for (const mode of ['close', 'close-or-exit', 'close-or-exit-background'] as const) {
      const state = makeState({ mode, worktrees: [worktree({ isMainWorktree: true })] })
      expect(resolveLastTabAutoDeleteTarget(state, candidate())).toBeNull()
    }
  })

  it('honours skip-pinned for worktrees', () => {
    const pinned = [worktree({ isPinned: true })]
    expect(resolveLastTabAutoDeleteTarget(makeState({ worktrees: pinned }), candidate())).toBeNull()
    expect(
      resolveLastTabAutoDeleteTarget(
        makeState({ worktrees: pinned, skipPinned: false }),
        candidate()
      )
    ).not.toBeNull()
  })

  it('skips SSH worktrees by host or by repo connection when skip-ssh is on', () => {
    const byHost = makeState({ skipSsh: true, worktrees: [worktree({ hostId: 'ssh:box' })] })
    expect(resolveLastTabAutoDeleteTarget(byHost, candidate({ hostId: 'ssh:box' }))).toBeNull()
    const byRepo = makeState({
      skipSsh: true,
      worktrees: [worktree({ hostId: undefined })],
      repos: [{ id: 'repo', connectionId: 'box' }]
    })
    expect(resolveLastTabAutoDeleteTarget(byRepo, candidate({ hostId: undefined }))).toBeNull()
  })

  it('rejects another incarnation, a vanished workspace and a workspace with tabs again', () => {
    const state = makeState({ worktrees: [worktree({ instanceId: 'i2' })] })
    expect(resolveLastTabAutoDeleteTarget(state, candidate())).toBeNull()
    expect(resolveLastTabAutoDeleteTarget(makeState({}), candidate())).toBeNull()
    const withTabs = makeState({ worktrees: [worktree()], tabCount: 1 })
    expect(resolveLastTabAutoDeleteTarget(withTabs, candidate())).toBeNull()
  })

  it('resolves a plain worktree', () => {
    const target = resolveLastTabAutoDeleteTarget(
      makeState({ worktrees: [worktree()] }),
      candidate()
    )
    expect(target).toMatchObject({ kind: 'worktree', worktree: { id: WT, instanceId: 'i1' } })
  })

  describe('folder workspaces', () => {
    const folderCandidate = (extra: Partial<LastTabAutoDeleteCandidate> = {}) =>
      candidate({ workspaceKey: 'folder:f1', instanceId: undefined, ...extra })

    it('resolves a folder whose host comes from its group', () => {
      const state = makeState({
        folders: [{ id: 'f1', projectGroupId: 'g1' }],
        groups: [{ id: 'g1' }]
      })
      expect(resolveLastTabAutoDeleteTarget(state, folderCandidate())).toEqual({
        kind: 'folder',
        folderWorkspaceId: 'f1',
        executionHostId: 'local'
      })
    })

    it('honours skip-folder and skip-pinned', () => {
      const folders = [{ id: 'f1', projectGroupId: 'g1', isPinned: true }]
      expect(
        resolveLastTabAutoDeleteTarget(
          makeState({ folders, groups: [{ id: 'g1' }] }),
          folderCandidate()
        )
      ).toBeNull()
      expect(
        resolveLastTabAutoDeleteTarget(
          makeState({ skipFolder: true, skipPinned: false, folders, groups: [{ id: 'g1' }] }),
          folderCandidate()
        )
      ).toBeNull()
    })

    it('skips SSH folders, including via the group connection, when only skip-ssh is on', () => {
      const own = makeState({
        skipSsh: true,
        folders: [{ id: 'f1', projectGroupId: 'g1', connectionId: 'box' }],
        groups: [{ id: 'g1' }]
      })
      expect(resolveLastTabAutoDeleteTarget(own, folderCandidate({ hostId: 'ssh:box' }))).toBeNull()
      const viaGroup = makeState({
        skipSsh: true,
        folders: [{ id: 'f1', projectGroupId: 'g1' }],
        groups: [{ id: 'g1', connectionId: 'box' }]
      })
      expect(
        resolveLastTabAutoDeleteTarget(viaGroup, folderCandidate({ hostId: 'ssh:box' }))
      ).toBeNull()
    })

    it('rejects a same-id folder that now lives on another host', () => {
      const state = makeState({
        folders: [{ id: 'f1', projectGroupId: 'g1', connectionId: 'box' }],
        groups: [{ id: 'g1' }]
      })
      expect(resolveLastTabAutoDeleteTarget(state, folderCandidate({ hostId: 'local' }))).toBeNull()
    })
  })
})

describe('captureLastTabAutoDeleteCandidate', () => {
  afterEach(() => {
    delete (globalThis as { __ORCA_WEB_CLIENT__?: boolean }).__ORCA_WEB_CLIENT__
  })

  it('captures nothing for the floating panel, when off, or in a paired web client', () => {
    const state = makeState({ worktrees: [worktree()], activeWorktreeId: WT })
    expect(
      captureLastTabAutoDeleteCandidate(state, 'global-floating-terminal', { trigger: 'close' })
    ).toBeNull()
    const off = makeState({ mode: 'off', worktrees: [worktree()] })
    expect(captureLastTabAutoDeleteCandidate(off, WT, { trigger: 'close' })).toBeNull()
    ;(globalThis as { __ORCA_WEB_CLIENT__?: boolean }).__ORCA_WEB_CLIENT__ = true
    expect(captureLastTabAutoDeleteCandidate(state, WT, { trigger: 'close' })).toBeNull()
  })

  it('records whether the workspace was active and takes its host from the selection', () => {
    const rows = [worktree({ hostId: 'ssh:box', instanceId: 'remote' }), worktree()]
    const active = makeState({ worktrees: rows, activeWorktreeId: WT, activeHostId: 'ssh:box' })
    expect(captureLastTabAutoDeleteCandidate(active, WT, { trigger: 'exit' })).toEqual({
      workspaceKey: WT,
      trigger: 'exit',
      wasActive: true,
      hostId: 'ssh:box',
      instanceId: 'remote'
    })
    const inactive = makeState({ worktrees: [worktree()] })
    expect(captureLastTabAutoDeleteCandidate(inactive, WT, { trigger: 'exit' })).toMatchObject({
      wasActive: false,
      hostId: 'local',
      instanceId: 'i1'
    })
  })

  it('refuses to guess the host of an inactive id published by two hosts', () => {
    const rows = [worktree({ hostId: 'ssh:box', instanceId: 'remote' }), worktree()]
    const state = makeState({ worktrees: rows })
    expect(captureLastTabAutoDeleteCandidate(state, WT, { trigger: 'close' })).toBeNull()
    expect(
      captureLastTabAutoDeleteCandidate(state, WT, { trigger: 'close', hostId: 'local' })
    ).toMatchObject({ hostId: 'local', instanceId: 'i1' })
  })

  it('never swaps a named host for the only folder row on another host', () => {
    const state = makeState({
      folders: [{ id: 'f1', projectGroupId: 'g1', connectionId: 'box' }],
      groups: [{ id: 'g1' }]
    })
    expect(
      captureLastTabAutoDeleteCandidate(state, 'folder:f1', { trigger: 'close', hostId: 'local' })
    ).toBeNull()
  })

  it('refuses to guess the host of an inactive folder published by local and SSH', () => {
    const state = makeState({
      folders: [
        { id: 'f1', projectGroupId: 'g1' },
        { id: 'f1', projectGroupId: 'g1', connectionId: 'box' }
      ],
      groups: [{ id: 'g1' }]
    })
    expect(captureLastTabAutoDeleteCandidate(state, 'folder:f1', { trigger: 'close' })).toBeNull()
  })
})
