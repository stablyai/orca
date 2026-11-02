import { beforeEach, describe, expect, it, vi } from 'vitest'
import { installAttentionScreen } from './workspace-attention/workspace-unread-characterization-fixture'
import type { AppState } from '../types'
import { makeDetectedResult } from './worktrees-detected-listing-fixtures'
import { makeWorktree } from './worktrees-slice-test-fixtures'
import {
  createTestStore,
  mockApi,
  resetRemoteRuntimeMocks,
  resetWorktreeSliceModuleMemory,
  runtimeEnvironmentCall
} from './worktrees-slice-test-harness'

const requestWorktreeBaseFallbackNotice = vi.hoisted(() => vi.fn())

vi.mock('sonner', () => ({
  toast: {
    warning: vi.fn(),
    info: vi.fn(),
    success: vi.fn(),
    error: vi.fn(),
    dismiss: vi.fn()
  }
}))

vi.mock('@/components/worktree-base-fallback-notice', () => ({
  requestWorktreeBaseFallbackNotice
}))

beforeEach(resetWorktreeSliceModuleMemory)

// Why: ghostty "show until interact" — attention raises the dot even on the active worktree; only engagement clears it.
describe('worktree unread (show-until-interact)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetRemoteRuntimeMocks()
  })

  it('marking sets isUnread even when the worktree is active', async () => {
    const store = createTestStore()
    const wt = makeWorktree({ id: 'repo1::/path/wt1', repoId: 'repo1', path: '/path/wt1' })
    store.setState({
      worktreesByRepo: { repo1: [wt] },
      activeWorktreeId: wt.id
    } as Partial<AppState>)

    store.getState().markAgentAttentionUnread({
      workspaceId: wt.id,
      subjectKey: null,
      groupId: null,
      reason: 'agent-completion'
    })

    const after = store.getState().worktreesByRepo.repo1[0]
    expect(after.isUnread).toBe(true)
    expect(mockApi.worktrees.updateMeta).toHaveBeenCalledWith(
      expect.objectContaining({
        worktreeId: wt.id,
        updates: expect.objectContaining({ isUnread: true })
      })
    )
  })

  it('routes multi-host project unread persistence by the worktree host (#10634)', () => {
    const store = createTestStore()
    const wt = makeWorktree({
      id: 'repo-shared::/home/user/wt',
      repoId: 'repo-shared',
      path: '/home/user/wt',
      hostId: 'ssh:ssh-1'
    })
    store.setState({
      repos: [
        { id: 'repo-shared', path: '/local', displayName: 'Local', badgeColor: '#000', addedAt: 0 },
        {
          id: 'repo-shared',
          path: '/home/user/repo',
          displayName: 'SSH',
          badgeColor: '#111',
          addedAt: 1,
          connectionId: 'ssh-1'
        }
      ],
      worktreesByRepo: { 'repo-shared': [wt] }
    } as Partial<AppState>)

    expect(() =>
      store.getState().markAgentAttentionUnread({
        workspaceId: wt.id,
        subjectKey: null,
        groupId: null,
        reason: 'agent-completion'
      })
    ).not.toThrow()

    expect(store.getState().worktreesByRepo['repo-shared'][0].isUnread).toBe(true)
    expect(mockApi.worktrees.updateMeta).toHaveBeenCalledWith(
      expect.objectContaining({
        worktreeId: wt.id,
        updates: expect.objectContaining({ isUnread: true })
      })
    )
  })

  it('keeps unread state local instead of throwing for genuinely ambiguous owners (#10634)', () => {
    const store = createTestStore()
    const worktreeId = 'repo-shared::/same/path'
    store.setState({
      settings: { activeRuntimeEnvironmentId: 'hub-c' } as never,
      worktreesByRepo: {
        'repo-shared': [
          makeWorktree({
            id: worktreeId,
            repoId: 'repo-shared',
            hostId: 'ssh:ssh-a',
            runtimeOwnerEnvironmentId: 'hub-a'
          }),
          makeWorktree({
            id: worktreeId,
            repoId: 'repo-shared',
            hostId: 'ssh:ssh-b',
            runtimeOwnerEnvironmentId: 'hub-b'
          })
        ]
      }
    } as Partial<AppState>)

    expect(() =>
      store.getState().markAgentAttentionUnread({
        workspaceId: worktreeId,
        subjectKey: null,
        groupId: null,
        reason: 'agent-completion'
      })
    ).not.toThrow()

    expect(store.getState().worktreesByRepo['repo-shared'][0].isUnread).toBe(true)
    expect(mockApi.worktrees.updateMeta).not.toHaveBeenCalled()
    expect(runtimeEnvironmentCall).not.toHaveBeenCalled()
  })

  it('never throws from any passive path for a genuinely ambiguous owner (#10634)', () => {
    // Why every passive path, not just marking: each one runs from a background
    // notification, so any that still throws reproduces the uncaught renderer error.
    const worktreeId = 'repo-shared::/same/path'
    const ambiguousState = (): Partial<AppState> =>
      ({
        settings: { activeRuntimeEnvironmentId: 'hub-c' } as never,
        worktreesByRepo: {
          'repo-shared': [
            makeWorktree({
              id: worktreeId,
              repoId: 'repo-shared',
              hostId: 'ssh:ssh-a',
              runtimeOwnerEnvironmentId: 'hub-a',
              isUnread: true
            }),
            makeWorktree({
              id: worktreeId,
              repoId: 'repo-shared',
              hostId: 'ssh:ssh-b',
              runtimeOwnerEnvironmentId: 'hub-b',
              isUnread: true
            })
          ]
        }
      }) as Partial<AppState>

    for (const [label, run] of [
      [
        'readOnScreenAttention',
        (s: AppState) =>
          s.readOnScreenAttention(
            { workspaceIds: [worktreeId], targets: [{ worktreeId: worktreeId, tabId: 'no-tab' }] },
            { screenArrived: true }
          )
      ],
      ['bumpWorktreeActivity', (s: AppState) => s.bumpWorktreeActivity(worktreeId)]
    ] as const) {
      const store = createTestStore()
      store.setState(ambiguousState())
      mockApi.worktrees.updateMeta.mockClear()

      expect(() => run(store.getState()), `${label} threw for an ambiguous owner`).not.toThrow()
      expect(
        mockApi.worktrees.updateMeta,
        `${label} persisted to a guessed host`
      ).not.toHaveBeenCalled()
    }
  })

  it('warns once per workspace rather than on every activity event (#10634)', () => {
    // Why: activity bumps fire on every PTY event; an unbounded warn would flood the console.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const worktreeId = 'repo-spam::/same/path'
      const store = createTestStore()
      store.setState({
        settings: { activeRuntimeEnvironmentId: 'hub-c' } as never,
        worktreesByRepo: {
          'repo-spam': [
            makeWorktree({ id: worktreeId, repoId: 'repo-spam', hostId: 'ssh:ssh-a' }),
            makeWorktree({ id: worktreeId, repoId: 'repo-spam', hostId: 'ssh:ssh-b' })
          ]
        }
      } as Partial<AppState>)

      const before = warn.mock.calls.length
      for (let i = 0; i < 5; i++) {
        store.getState().bumpWorktreeActivity(worktreeId)
      }

      expect(warn.mock.calls.length - before).toBe(1)
    } finally {
      warn.mockRestore()
    }
  })

  it('reading clears isUnread and persists the change', async () => {
    const store = createTestStore()
    const wt = makeWorktree({
      id: 'repo1::/path/wt1',
      repoId: 'repo1',
      path: '/path/wt1',
      isUnread: true
    })
    store.setState({
      worktreesByRepo: { repo1: [wt] },
      activeWorktreeId: wt.id
    } as Partial<AppState>)

    store
      .getState()
      .readOnScreenAttention({ workspaceIds: [wt.id], targets: [] }, { screenArrived: true })

    const after = store.getState().worktreesByRepo.repo1[0]
    expect(after.isUnread).toBe(false)
    expect(mockApi.worktrees.updateMeta).toHaveBeenCalledWith(
      expect.objectContaining({
        worktreeId: wt.id,
        updates: { isUnread: false }
      })
    )
  })

  it('reading is a no-op when already cleared', () => {
    const store = createTestStore()
    const wt = makeWorktree({ id: 'repo1::/path/wt1', repoId: 'repo1', path: '/path/wt1' })
    const initial = { repo1: [wt] }
    store.setState({ worktreesByRepo: initial } as Partial<AppState>)

    store
      .getState()
      .readOnScreenAttention({ workspaceIds: [wt.id], targets: [] }, { screenArrived: true })

    expect(store.getState().worktreesByRepo).toBe(initial)
    expect(mockApi.worktrees.updateMeta).not.toHaveBeenCalled()
  })

  it('updates unread state for hidden detected worktrees', () => {
    const store = createTestStore()
    const hidden = makeWorktree({
      id: 'repo1::/path/hidden',
      repoId: 'repo1',
      path: '/path/hidden'
    })
    const detected = makeDetectedResult('repo1', [hidden])
    detected.worktrees[0] = { ...detected.worktrees[0], ownership: 'external', visible: false }
    store.setState({
      worktreesByRepo: { repo1: [] },
      detectedWorktreesByRepo: { repo1: detected }
    } as Partial<AppState>)

    store.getState().markAgentAttentionUnread({
      workspaceId: hidden.id,
      subjectKey: null,
      groupId: null,
      reason: 'agent-completion'
    })
    expect(store.getState().detectedWorktreesByRepo.repo1.worktrees[0].isUnread).toBe(true)

    store
      .getState()
      .readOnScreenAttention({ workspaceIds: [hidden.id], targets: [] }, { screenArrived: true })
    expect(store.getState().detectedWorktreesByRepo.repo1.worktrees[0].isUnread).toBe(false)
    expect(mockApi.worktrees.updateMeta).toHaveBeenCalledTimes(2)
  })

  it('reads a hidden detected worktree once it is activated and on screen', () => {
    const store = createTestStore()
    const hidden = makeWorktree({
      id: 'repo1::/path/hidden',
      repoId: 'repo1',
      path: '/path/hidden',
      isUnread: true
    })
    const detected = makeDetectedResult('repo1', [hidden])
    detected.worktrees[0] = { ...detected.worktrees[0], ownership: 'external', visible: false }
    store.setState({
      worktreesByRepo: { repo1: [] },
      detectedWorktreesByRepo: { repo1: detected }
    } as Partial<AppState>)

    installAttentionScreen(store, true)
    store.setState({ activeView: 'settings' })
    store.getState().setActiveWorktree(hidden.id)
    // Settings is not the workspace's own view, so nothing is on screen yet.
    expect(store.getState().detectedWorktreesByRepo.repo1.worktrees[0].isUnread).toBe(true)

    store.setState({ activeView: 'terminal' })

    expect(store.getState().activeWorktreeId).toBe(hidden.id)
    expect(store.getState().detectedWorktreesByRepo.repo1.worktrees[0].isUnread).toBe(false)
    expect(mockApi.worktrees.updateMeta).toHaveBeenCalledWith(
      expect.objectContaining({
        worktreeId: hidden.id,
        updates: { isUnread: false }
      })
    )
  })
})
