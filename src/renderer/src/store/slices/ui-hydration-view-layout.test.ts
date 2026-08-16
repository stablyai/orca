import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getDefaultUIState } from '../../../../shared/constants'
import type { PersistedUIState } from '../../../../shared/persisted-ui-state-types'
import type { Repo } from '../../../../shared/repo-types'
import type { AppState } from '../types'
import { getSetupScriptPromptDismissalKey } from '../../lib/setup-script-prompt'
import { getRepoHostIdentityForParts } from './repo-host-identity'
import { createUIStore, makePersistedUI } from './ui-slice-test-harness'

const mocks = vi.hoisted(() => ({
  sendNotesToActiveAgentSession: vi.fn(),
  track: vi.fn(),
  toastMessage: vi.fn(),
  toastSuccess: vi.fn(),
  toastError: vi.fn()
}))

vi.mock('@/lib/active-agent-note-send', () => ({
  activeAgentNotesSendFailureMessage: (
    status: string,
    options: { explicitTarget?: boolean } = {}
  ) => (options.explicitTarget ? `selected:${status}` : status),
  sendNotesToActiveAgentSession: mocks.sendNotesToActiveAgentSession
}))

vi.mock('@/lib/telemetry', () => ({
  track: mocks.track
}))

vi.mock('sonner', () => ({
  toast: {
    message: mocks.toastMessage,
    success: mocks.toastSuccess,
    error: mocks.toastError
  }
}))

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

beforeEach(() => {
  mocks.sendNotesToActiveAgentSession.mockReset()
  mocks.sendNotesToActiveAgentSession.mockResolvedValue({ status: 'sent' })
  mocks.track.mockReset()
  mocks.toastMessage.mockReset()
  mocks.toastSuccess.mockReset()
  mocks.toastError.mockReset()
})

describe('createUISlice hydratePersistedUI', () => {
  it('defaults persisted right sidebar visibility to open', () => {
    expect(getDefaultUIState().rightSidebarOpen).toBe(true)
  })

  it('defaults to showing sleeping workspaces', () => {
    const store = createUIStore()

    expect(store.getState().showSleepingWorkspaces).toBe(true)
  })

  it('defaults the default-branch sleeping exemption to on', () => {
    expect(getDefaultUIState().alwaysShowDefaultBranchWorkspace).toBe(true)
    expect(createUIStore().getState().alwaysShowDefaultBranchWorkspace).toBe(true)
  })

  it('treats a legacy profile with no default-branch exemption key as opted in', () => {
    // Why: profiles written before #8873 are exactly the ones showing the bug,
    // so an absent key must hydrate to on rather than silently re-hiding main.
    const store = createUIStore()
    const legacy = makePersistedUI()
    delete (legacy as Partial<PersistedUIState>).alwaysShowDefaultBranchWorkspace

    store.getState().hydratePersistedUI(legacy, 'startup')

    expect(store.getState().alwaysShowDefaultBranchWorkspace).toBe(true)
  })

  it('preserves an explicit default-branch exemption opt-out on hydration', () => {
    const store = createUIStore()

    store
      .getState()
      .hydratePersistedUI(makePersistedUI({ alwaysShowDefaultBranchWorkspace: false }), 'startup')

    expect(store.getState().alwaysShowDefaultBranchWorkspace).toBe(false)
  })

  it('defaults workspace host scope to all hosts', () => {
    expect(getDefaultUIState().workspaceHostScope).toBe('all')
    expect(createUIStore().getState().workspaceHostScope).toBe('all')
    expect(getDefaultUIState().visibleWorkspaceHostIds).toBeNull()
    expect(createUIStore().getState().visibleWorkspaceHostIds).toBeNull()
    expect(getDefaultUIState().workspaceHostOrder).toEqual([])
    expect(createUIStore().getState().workspaceHostOrder).toEqual([])
    expect(getDefaultUIState().manualRepoOrder).toEqual([])
    expect(createUIStore().getState().manualRepoOrder).toEqual([])
  })

  it('defaults the persisted active view to terminal', () => {
    expect(getDefaultUIState().activeView).toBe('terminal')
    expect(createUIStore().getState().activeView).toBe('terminal')
  })

  it('restores the persisted active top-level view on hydration', () => {
    const store = createUIStore()

    store.getState().hydratePersistedUI(makePersistedUI({ activeView: 'tasks' }), 'startup')

    expect(store.getState().activeView).toBe('tasks')
  })

  it('falls back to terminal when persisted active view is missing (older data)', () => {
    const store = createUIStore()
    store.setState({ activeView: 'tasks' })

    store.getState().hydratePersistedUI(
      {
        ...makePersistedUI(),
        activeView: undefined as unknown as PersistedUIState['activeView']
      },
      'startup'
    )

    expect(store.getState().activeView).toBe('terminal')
  })

  it('restores a persisted skills view', () => {
    const store = createUIStore()
    store.setState({ activeView: 'tasks' })

    store.getState().hydratePersistedUI(makePersistedUI({ activeView: 'skills' }), 'startup')

    expect(store.getState().activeView).toBe('skills')
  })

  it('falls back to terminal when the persisted active view is not a known view', () => {
    const store = createUIStore()

    store.getState().hydratePersistedUI(
      makePersistedUI({
        activeView: 'not-a-real-view' as unknown as PersistedUIState['activeView']
      }),
      'startup'
    )

    expect(store.getState().activeView).toBe('terminal')
  })

  it('drops a persisted activity view when experimental activity is disabled', () => {
    const store = createUIStore()
    store.setState({
      settings: { experimentalActivity: false } as AppState['settings']
    })

    store.getState().hydratePersistedUI(makePersistedUI({ activeView: 'activity' }), 'startup')

    expect(store.getState().activeView).toBe('terminal')
  })

  it('restores a persisted activity view when experimental activity is enabled', () => {
    const store = createUIStore()
    store.setState({
      settings: { experimentalActivity: true } as AppState['settings']
    })

    store.getState().hydratePersistedUI(makePersistedUI({ activeView: 'activity' }), 'startup')

    expect(store.getState().activeView).toBe('activity')
  })

  it('restores a default-on view (mobile) even when its nav button is hidden', () => {
    const store = createUIStore()
    store.setState({
      settings: { showMobileButton: false } as AppState['settings']
    })

    store.getState().hydratePersistedUI(makePersistedUI({ activeView: 'mobile' }), 'startup')

    expect(store.getState().activeView).toBe('mobile')
  })

  it('does not overwrite the current view on a later cross-window sync hydration', () => {
    const store = createUIStore()
    store.getState().hydratePersistedUI(makePersistedUI({ activeView: 'tasks' }), 'startup')
    expect(store.getState().activeView).toBe('tasks')

    store
      .getState()
      .hydratePersistedUI(
        makePersistedUI({ activeView: 'terminal', rightSidebarOpen: false }),
        'sync'
      )

    expect(store.getState().activeView).toBe('tasks')
    expect(store.getState().rightSidebarOpen).toBe(false)
  })

  it('preserves the current right sidebar width when older persisted UI omits it', () => {
    const store = createUIStore()

    store.setState({ rightSidebarWidth: 360 })
    store.getState().hydratePersistedUI({
      ...makePersistedUI(),
      rightSidebarWidth: undefined as unknown as number
    })

    expect(store.getState().rightSidebarWidth).toBe(360)
  })

  it('hydrates a persisted closed right sidebar preference', () => {
    const store = createUIStore()

    store.getState().hydratePersistedUI(makePersistedUI({ rightSidebarOpen: false }))

    expect(store.getState().rightSidebarOpen).toBe(false)
  })

  it('hydrates a persisted open right sidebar preference', () => {
    const store = createUIStore()

    store.getState().hydratePersistedUI(makePersistedUI({ rightSidebarOpen: true }))

    expect(store.getState().rightSidebarOpen).toBe(true)
  })

  it('hydrates a persisted right sidebar tab preference', () => {
    const store = createUIStore()

    store.getState().hydratePersistedUI(makePersistedUI({ rightSidebarTab: 'checks' }))

    expect(store.getState().rightSidebarTab).toBe('checks')
    expect(store.getState().rightSidebarExplorerView).toBe('files')
  })

  it('preserves persisted repo filters until repos are loaded', () => {
    const store = createUIStore()
    const remoteDismissalKey = getSetupScriptPromptDismissalKey(
      getRepoHostIdentityForParts('remote-repo', 'runtime:env-1')
    )

    store.getState().hydratePersistedUI(
      makePersistedUI({
        filterRepoIds: ['remote-repo', 12 as never, 'stale-repo'],
        trustedOrcaHooks: {
          'remote-repo': { all: { approvedAt: 1 } },
          'bad-shape': 'yes' as never
        },
        setupScriptPromptDismissedRepoIds: [remoteDismissalKey, 'remote-repo', remoteDismissalKey]
      })
    )

    expect(store.getState().filterRepoIds).toEqual(['remote-repo', 'stale-repo'])
    expect(store.getState().trustedOrcaHooks).toEqual({
      'remote-repo': { all: { approvedAt: 1 } }
    })
    expect(store.getState().setupScriptPromptDismissedRepoIds).toEqual([remoteDismissalKey])
  })

  it('validates persisted repo filters when repos are already loaded', () => {
    const store = createUIStore()
    const localDismissalKey = getSetupScriptPromptDismissalKey(
      getRepoHostIdentityForParts('local-repo', 'local')
    )
    const staleDismissalKey = getSetupScriptPromptDismissalKey(
      getRepoHostIdentityForParts('stale-repo', 'local')
    )
    store.setState({
      repos: [
        { id: 'local-repo', path: '/local', displayName: 'Local', badgeColor: '#000', addedAt: 1 }
      ]
    } as Partial<AppState>)

    store.getState().hydratePersistedUI(
      makePersistedUI({
        filterRepoIds: ['local-repo', 'stale-repo'],
        trustedOrcaHooks: {
          'local-repo': { all: { approvedAt: 1 } },
          'stale-repo': { all: { approvedAt: 2 } }
        },
        setupScriptPromptDismissedRepoIds: [localDismissalKey, staleDismissalKey]
      })
    )

    expect(store.getState().filterRepoIds).toEqual(['local-repo'])
    expect(store.getState().trustedOrcaHooks).toEqual({
      'local-repo': { all: { approvedAt: 1 } }
    })
    expect(store.getState().setupScriptPromptDismissedRepoIds).toEqual([localDismissalKey])
  })

  it('hydrates legacy persisted search tab as Explorer search', () => {
    const store = createUIStore()

    store.getState().hydratePersistedUI(makePersistedUI({ rightSidebarTab: 'search' }))

    expect(store.getState().rightSidebarTab).toBe('explorer')
    expect(store.getState().rightSidebarExplorerView).toBe('search')
  })

  it('hydrates persisted Explorer search view', () => {
    const store = createUIStore()

    store
      .getState()
      .hydratePersistedUI(
        makePersistedUI({ rightSidebarTab: 'explorer', rightSidebarExplorerView: 'search' })
      )

    expect(store.getState().rightSidebarTab).toBe('explorer')
    expect(store.getState().rightSidebarExplorerView).toBe('search')
  })

  it('hydrates a persisted workspace host scope', () => {
    const store = createUIStore()

    store.getState().hydratePersistedUI(makePersistedUI({ workspaceHostScope: 'ssh:win%20vm' }))

    expect(store.getState().workspaceHostScope).toBe('ssh:win%20vm')
    expect(store.getState().visibleWorkspaceHostIds).toEqual(['ssh:win%20vm'])
  })

  it('hydrates a persisted visible workspace host set', () => {
    const store = createUIStore()

    store.getState().hydratePersistedUI(
      makePersistedUI({
        workspaceHostScope: 'ssh:win%20vm',
        visibleWorkspaceHostIds: [
          'local',
          'ssh:win%20vm',
          'bogus' as NonNullable<PersistedUIState['visibleWorkspaceHostIds']>[number],
          'local'
        ]
      })
    )

    expect(store.getState().workspaceHostScope).toBe('ssh:win%20vm')
    expect(store.getState().visibleWorkspaceHostIds).toEqual(['local', 'ssh:win%20vm'])
  })

  it('hydrates a persisted workspace host order', () => {
    const store = createUIStore()

    store.getState().hydratePersistedUI(
      makePersistedUI({
        workspaceHostOrder: [
          'ssh:win%20vm',
          'bogus' as NonNullable<PersistedUIState['workspaceHostOrder']>[number],
          'local',
          'ssh:win%20vm'
        ]
      })
    )

    expect(store.getState().workspaceHostOrder).toEqual(['ssh:win%20vm', 'local'])
  })

  it('hydrates and immediately applies the manual cross-host repo order', () => {
    const store = createUIStore()
    const local: Repo = {
      id: 'same',
      path: '/local',
      displayName: 'Local',
      badgeColor: '#000',
      addedAt: 1,
      executionHostId: 'local'
    }
    const remote: Repo = {
      ...local,
      path: '/remote',
      displayName: 'Remote',
      executionHostId: 'runtime:node-b'
    }
    store.setState({ repos: [local, remote] })

    store.getState().hydratePersistedUI(
      makePersistedUI({
        manualRepoOrder: [
          { hostId: 'runtime:node-b', repoId: 'same' },
          { hostId: 'invalid' as never, repoId: 'ignored' },
          { hostId: 'local', repoId: 'same' }
        ]
      })
    )

    expect(store.getState().manualRepoOrder).toEqual([
      { hostId: 'runtime:node-b', repoId: 'same' },
      { hostId: 'local', repoId: 'same' }
    ])
    expect(store.getState().repos).toEqual([remote, local])
  })

  it('falls back to all hosts for invalid persisted workspace host scopes', () => {
    const store = createUIStore()

    store
      .getState()
      .hydratePersistedUI(
        makePersistedUI({ workspaceHostScope: 'bogus' as PersistedUIState['workspaceHostScope'] })
      )

    expect(store.getState().workspaceHostScope).toBe('all')
    expect(store.getState().visibleWorkspaceHostIds).toBeNull()
  })

  it('tracks the per-project settings host selection without persisting it', () => {
    const setUI = vi.fn(() => Promise.resolve())
    vi.stubGlobal('window', { api: { ui: { set: setUI } } })
    const store = createUIStore()

    store.getState().setSettingsProjectHostSelection('git:acme/app', 'runtime:home-mac')

    expect(store.getState().settingsProjectHostSelection).toEqual({
      'git:acme/app': 'runtime:home-mac'
    })
    expect(store.getState().settingsProjectSetupSelection).toEqual({})

    store
      .getState()
      .setSettingsProjectHostSelection('git:acme/app', 'runtime:home-mac', 'jump-setup')
    expect(store.getState().settingsProjectSetupSelection).toEqual({
      'git:acme/app': 'jump-setup'
    })
    // Ephemeral: never written through the UI persistence pipeline.
    expect(setUI).not.toHaveBeenCalled()
  })

  it('persists workspace host scope changes', () => {
    const setUI = vi.fn(() => Promise.resolve())
    vi.stubGlobal('window', { api: { ui: { set: setUI } } })
    const store = createUIStore()

    store.getState().setWorkspaceHostScope('runtime:env-1')

    expect(store.getState().workspaceHostScope).toBe('runtime:env-1')
    expect(store.getState().visibleWorkspaceHostIds).toEqual(['runtime:env-1'])
    expect(setUI).toHaveBeenCalledWith({
      workspaceHostScope: 'runtime:env-1',
      visibleWorkspaceHostIds: ['runtime:env-1']
    })
  })

  it('persists visible workspace host changes independently of focused host', () => {
    const setUI = vi.fn(() => Promise.resolve())
    vi.stubGlobal('window', { api: { ui: { set: setUI } } })
    const store = createUIStore()

    store.getState().setWorkspaceHostScope('runtime:env-1')
    store.getState().setVisibleWorkspaceHostIds(['local', 'runtime:env-1'])

    expect(store.getState().workspaceHostScope).toBe('runtime:env-1')
    expect(store.getState().visibleWorkspaceHostIds).toEqual(['local', 'runtime:env-1'])
    expect(setUI).toHaveBeenLastCalledWith({
      workspaceHostScope: 'runtime:env-1',
      visibleWorkspaceHostIds: ['local', 'runtime:env-1']
    })
  })

  it('persists workspace host order changes', () => {
    const setUI = vi.fn(() => Promise.resolve())
    vi.stubGlobal('window', { api: { ui: { set: setUI } } })
    const store = createUIStore()

    store.getState().setWorkspaceHostOrder(['ssh:win%20vm', 'bogus' as never, 'local'])

    expect(store.getState().workspaceHostOrder).toEqual(['ssh:win%20vm', 'local'])
    expect(setUI).toHaveBeenCalledWith({ workspaceHostOrder: ['ssh:win%20vm', 'local'] })
  })

  it('persists group changes with collapsed groups cleared', () => {
    const setUI = vi.fn(() => Promise.resolve())
    vi.stubGlobal('window', { api: { ui: { set: setUI } } })
    const store = createUIStore()

    store.setState({ collapsedGroups: new Set(['repo:old']) })
    store.getState().setGroupBy('none')

    expect(store.getState().groupBy).toBe('none')
    expect([...store.getState().collapsedGroups]).toEqual([])
    expect(setUI).toHaveBeenCalledWith({ groupBy: 'none', collapsedGroups: [] })
  })

  it('hydrates persisted per-worktree dotfile visibility', () => {
    const store = createUIStore()

    store.getState().hydratePersistedUI(
      makePersistedUI({
        showDotfilesByWorktree: {
          'repo-1::/repo': false,
          'repo-2::/repo': true
        }
      })
    )

    expect(store.getState().showDotfilesByWorktree).toEqual({
      'repo-1::/repo': false,
      'repo-2::/repo': true
    })
  })

  it('does not churn persisted UI references when hydration is identical by value', () => {
    const store = createUIStore()
    const persistedUI = makePersistedUI({
      featureTipsSeenIds: ['voice-dictation'],
      contextualToursSeenIds: ['tasks'],
      showDotfilesByWorktree: { 'repo-1::/repo': false },
      collapsedGroups: ['repo:one'],
      workspaceHostOrder: ['local'],
      worktreeCardProperties: ['status', 'unread', 'ports'],
      acknowledgedAgentsByPaneKey: { 'tab-1::pane-1': Date.now() }
    })

    store.getState().hydratePersistedUI(persistedUI)
    const before = store.getState()
    const references = {
      acknowledgedAgentsByPaneKey: before.acknowledgedAgentsByPaneKey,
      featureTipsSeenIds: before.featureTipsSeenIds,
      contextualToursSeenIds: before.contextualToursSeenIds,
      workspaceHostOrder: before.workspaceHostOrder,
      showDotfilesByWorktree: before.showDotfilesByWorktree,
      collapsedGroups: before.collapsedGroups,
      worktreeCardProperties: before.worktreeCardProperties
    }

    store.getState().hydratePersistedUI(makePersistedUI({ ...persistedUI }))
    const after = store.getState()

    expect(after.acknowledgedAgentsByPaneKey).toBe(references.acknowledgedAgentsByPaneKey)
    expect(after.featureTipsSeenIds).toBe(references.featureTipsSeenIds)
    expect(after.contextualToursSeenIds).toBe(references.contextualToursSeenIds)
    expect(after.workspaceHostOrder).toBe(references.workspaceHostOrder)
    expect(after.showDotfilesByWorktree).toBe(references.showDotfilesByWorktree)
    expect(after.collapsedGroups).toBe(references.collapsedGroups)
    expect(after.worktreeCardProperties).toBe(references.worktreeCardProperties)
  })

  it('drops invalid persisted per-worktree dotfile visibility entries', () => {
    const store = createUIStore()

    store.getState().hydratePersistedUI(
      makePersistedUI({
        showDotfilesByWorktree: {
          'repo-1::/repo': false,
          'repo-2::/repo': 'nope',
          constructor: false
        } as never
      })
    )

    expect(store.getState().showDotfilesByWorktree).toEqual({ 'repo-1::/repo': false })
  })

  it('stores only per-worktree dotfile visibility opt-outs', () => {
    const store = createUIStore()

    store.getState().setShowDotfilesForWorktree('repo-1::/repo', false)
    expect(store.getState().showDotfilesByWorktree).toEqual({ 'repo-1::/repo': false })

    store.getState().setShowDotfilesForWorktree('repo-1::/repo', true)
    expect(store.getState().showDotfilesByWorktree).toEqual({})
  })

  it('toggles per-worktree dotfile visibility independently', () => {
    const store = createUIStore()

    store.getState().toggleShowDotfilesForWorktree('repo-1::/repo')
    store.getState().toggleShowDotfilesForWorktree('repo-2::/repo')
    store.getState().toggleShowDotfilesForWorktree('repo-2::/repo')

    expect(store.getState().showDotfilesByWorktree).toEqual({ 'repo-1::/repo': false })
  })

  it('falls back to explorer for invalid persisted right sidebar tabs', () => {
    const store = createUIStore()

    store
      .getState()
      .hydratePersistedUI(
        makePersistedUI({ rightSidebarTab: 'bogus' as PersistedUIState['rightSidebarTab'] })
      )

    expect(store.getState().rightSidebarTab).toBe('explorer')
    expect(store.getState().rightSidebarExplorerView).toBe('files')
  })

  it('clamps persisted sidebar widths into the supported range', () => {
    const store = createUIStore()

    store.getState().hydratePersistedUI(
      makePersistedUI({
        sidebarWidth: 100,
        rightSidebarWidth: 100
      })
    )

    expect(store.getState().sidebarWidth).toBe(220)
    expect(store.getState().rightSidebarWidth).toBe(220)
  })

  it('clamps persisted markdown toc panel widths into the supported range', () => {
    const store = createUIStore()

    store.getState().hydratePersistedUI(
      makePersistedUI({
        markdownTocPanelWidth: 100
      })
    )

    expect(store.getState().markdownTocPanelWidth).toBe(200)
  })

  it('clamps persisted combined diff file tree widths into the supported range', () => {
    const store = createUIStore()

    store.getState().hydratePersistedUI(makePersistedUI({ combinedDiffFileTreeWidth: 100 }))
    expect(store.getState().combinedDiffFileTreeWidth).toBe(200)

    store.getState().hydratePersistedUI(makePersistedUI({ combinedDiffFileTreeWidth: 5_000 }))
    expect(store.getState().combinedDiffFileTreeWidth).toBe(640)
  })

  it('preserves right sidebar widths above the former 500px cap', () => {
    const store = createUIStore()

    store.getState().hydratePersistedUI(
      makePersistedUI({
        sidebarWidth: 260,
        rightSidebarWidth: 900
      })
    )

    // Left sidebar stays capped; right sidebar now allows wide drag targets
    // so long file names remain readable.
    expect(store.getState().sidebarWidth).toBe(260)
    expect(store.getState().rightSidebarWidth).toBe(900)
  })

  it('stores pending sidebar reveal rename requests', () => {
    const store = createUIStore()

    store.getState().revealWorktreeInSidebar('repo1::/feature', {
      behavior: 'smooth',
      highlight: true,
      beginRename: true
    })

    expect(store.getState().pendingRevealWorktree).toEqual({
      worktreeId: 'repo1::/feature',
      behavior: 'smooth',
      highlight: true,
      beginRename: true
    })
  })

  it('falls back to existing sidebar widths when persisted values are not finite', () => {
    const store = createUIStore()

    store.getState().setSidebarWidth(320)
    store.setState({ rightSidebarWidth: 360 })

    store.getState().hydratePersistedUI(
      makePersistedUI({
        sidebarWidth: Number.NaN,
        rightSidebarWidth: Number.POSITIVE_INFINITY
      })
    )

    expect(store.getState().sidebarWidth).toBe(320)
    expect(store.getState().rightSidebarWidth).toBe(360)
  })
})
