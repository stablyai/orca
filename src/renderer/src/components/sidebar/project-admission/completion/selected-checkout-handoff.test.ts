// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import { createStore } from 'zustand/vanilla'
import type { AppState } from '@/store/types'
import type { Repo } from '../../../../../../shared/repository/repo-types'
import type { DetectedWorktree } from '../../../../../../shared/worktree/types'
import { createRepoUpdateActions } from '@/store/repos/repo-update'
import { createRepoAddActions } from '@/store/repos/repo-add-actions'
import { act, cleanup, render, renderHook } from '@testing-library/react'
import { createElement } from 'react'
import AddProjectFromFolderDialog from '../dialog/AddProjectFromFolderDialog'
import { keepImportedWorktreesHiddenCard } from '../../worktree-list/listing/imported-worktrees-card-actions'
import { importNewExternalWorktreeInboxPaths } from '../../worktree-list/listing/new-external-worktrees-inbox-actions'
import {
  finishProjectAddWithDefaultCheckout,
  openProjectDefaultCheckout
} from './project-added-default-checkout'
import { captureCheckoutHandoffIntent } from './checkout-handoff-intent'
import { useAddRepoNestedImportFlow } from '../nested-import/useAddRepoNestedImportFlow'
import { useCompleteGitRepoAdd } from './use-complete-git-repo-add'
import type { NestedRepoScanResult } from '../../../../../../shared/project/groups/project-group-types'

type PersistRequest = { repoId: string; updates: object; hostId?: string }
type ToastOptions = { description?: string; action?: { onClick: () => void } }
type Harness = {
  state: AppState | null
  activate: Mock<(worktreeId: string, options: object) => void>
  persist: Mock<(request: PersistRequest) => Promise<Repo>>
  subscribe: Mock<(listener: (state: AppState) => void) => () => void>
  error: Mock<(message: string, options: ToastOptions) => void>
  onboarding: Mock<(step: string) => Promise<void>>
  add: Mock<(request: object) => Promise<unknown>>
}
const harness = vi.hoisted((): Harness => ({
  state: null,
  activate: vi.fn(),
  persist: vi.fn(),
  subscribe: vi.fn(),
  error: vi.fn(),
  onboarding: vi.fn(),
  add: vi.fn()
}))
vi.mock('@/store/index', async () => {
  const { useSyncExternalStore } = await import('react')
  // Mounted components subscribe like the app store's hook; handoff code reads getState.
  const useAppStore = <T>(selector: (state: AppState) => T): T =>
    useSyncExternalStore(
      (listener) => harness.subscribe(listener),
      () => selector(harness.state!)
    )
  return {
    useAppStore: Object.assign(useAppStore, {
      getState: () => harness.state!,
      subscribe: (listener: () => void) => harness.subscribe(listener)
    })
  }
})
vi.mock('@/store/projects/project-profile-presence', () => ({
  warnIfProjectKnownInAnotherProfile: async () => undefined
}))
vi.mock('@/store/projects/project-wsl-filesystem-boundary-advisory', () => ({
  warnIfProjectCrossesWslFilesystemBoundary: () => undefined
}))
vi.mock('sonner', () => ({
  toast: { error: harness.error, warning: vi.fn(), success: vi.fn(), info: vi.fn() }
}))
vi.mock('@/lib/workspace/activation/worktree-activation', () => ({
  activateAndRevealWorktree: harness.activate
}))
vi.mock('@/diagnostics/telemetry/telemetry', () => ({ track: vi.fn() }))
vi.mock('@/components/onboarding/onboarding-project-checklist', () => ({
  markOnboardingProjectAdded: harness.onboarding
}))
vi.mock('@/store/projects/project-host-routing', () => ({
  getProjectSetupRuntimeTarget: (hostId: string) =>
    hostId.startsWith('runtime:')
      ? { kind: 'environment', environmentId: hostId.slice('runtime:'.length) }
      : { kind: 'local' }
}))
// A paired host persists the same way; its replies are adopted under its own runtime: stamp.
vi.mock('@/runtime/rpc/calls/runtime-rpc-call', () => ({
  callRuntimeRpc: async (
    target: { environmentId: string },
    _method: string,
    params: { repo: string; updates: object }
  ) => ({
    repo: await harness.persist({
      repoId: params.repo,
      updates: params.updates,
      hostId: `runtime:${target.environmentId}`
    })
  })
}))

const repo: Repo = {
  id: 'project',
  path: '/repo',
  displayName: 'Project',
  badgeColor: '',
  addedAt: 0,
  kind: 'git'
}
function checkout(path: string, extra: Partial<DetectedWorktree> = {}): DetectedWorktree {
  return {
    id: `project::${path}`,
    repoId: 'project',
    path,
    displayName: path,
    comment: '',
    linkedIssue: null,
    linkedPR: null,
    linkedLinearIssue: null,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    branch: 'topic',
    head: 'abc',
    isBare: false,
    ownership: 'external',
    selectedCheckout: path === '/repo',
    isMainWorktree: path === '/repo',
    isArchived: false,
    lastActivityAt: 0,
    visible: true,
    ...extra
  }
}
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
function setup(rows: DetectedWorktree[], repos: Repo[] = [repo], confirmationFails = false) {
  let failing = confirmationFails
  const persisted = new Map<string, Repo>(repos.map((row) => [row.executionHostId ?? 'local', row]))
  harness.persist.mockImplementation(async ({ updates, hostId }) => {
    const owner = hostId ?? 'local'
    const next = { ...persisted.get(owner)!, ...updates }
    persisted.set(owner, next)
    return next
  })
  vi.stubGlobal(
    'window',
    Object.assign(window, { api: { repos: { update: harness.persist, add: harness.add } } })
  )
  const store = createStore<AppState>()(
    (set, get) =>
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: this fixture supplies every field read by the handoff and updater; unrelated app slices are not exercised.
      ({
        repos,
        projects: [],
        projectHostSetups: [],
        settings: {},
        activeModal: 'none',
        modalData: {},
        activeView: 'terminal',
        activeWorktreeId: null,
        activeWorkspaceExecutionHostId: null,
        activeTabType: 'terminal',
        activeTabId: null,
        activeBrowserTabId: null,
        activeFileId: null,
        activeGroupIdByWorktree: {},
        groupsByWorktree: {},
        browserTabsByWorktree: {},
        activeRepoId: null,
        showActiveOnly: false,
        setFilterRepoIds: vi.fn(),
        setShowActiveOnly: vi.fn(),
        worktreesByRepo: {},
        detectedWorktreesByRepo: {},
        hideDefaultBranchWorkspace: true,
        filterRepoIds: [],
        showSleepingWorkspaces: true,
        setActiveRepo: vi.fn(),
        setProjectFilterIds: vi.fn(),
        ...createRepoUpdateActions(set, get),
        ...createRepoAddActions(set, get),
        clearOrcaHookTrustForRepo: vi.fn(),
        activeOrcaProfileId: null,
        openModal: (activeModal: AppState['activeModal'], modalData: AppState['modalData'] = {}) =>
          set({ activeModal, modalData }),
        closeModal: () => set({ activeModal: 'none', modalData: {} }),
        fetchWorktrees: async () => {
          const imported = get().repos.flatMap((row) => row.importedExternalWorktreePaths ?? [])
          if (failing && imported.length > 0) {
            return false
          }
          const detected = rows.map((row) => ({
            ...row,
            visible: row.visible || imported.includes(row.path)
          }))
          set({
            detectedWorktreesByRepo: {
              project: {
                repoId: 'project',
                authoritative: true,
                source: 'git',
                worktrees: detected
              }
            },
            worktreesByRepo: { project: detected.filter((row) => row.visible) }
          })
          return true
        }
      }) as unknown as AppState
  )
  const synchronize = () => {
    harness.state = store.getState()
  }
  harness.subscribe.mockImplementation((listener) => store.subscribe(listener))
  store.subscribe(synchronize)
  synchronize()
  return {
    store,
    persisted,
    recover: () => {
      failing = false
    }
  }
}
async function open(selectedPath: string, executionHostId?: 'local' | 'runtime:env') {
  await openProjectDefaultCheckout({
    repoId: 'project',
    source: 'local_folder_picker',
    selectedPath,
    executionHostId
  })
}
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})
beforeEach(() => {
  vi.clearAllMocks()
  harness.onboarding.mockResolvedValue(undefined)
})

describe('selected checkout handoff', () => {
  it('preserves newer modal and workspace navigation while onboarding is pending', async () => {
    const { store } = setup([checkout('/repo'), checkout('/selected')])
    const gate = deferred<void>()
    harness.onboarding.mockReturnValueOnce(gate.promise)
    store.setState({
      activeModal: 'confirm-add-project-from-folder',
      modalData: { folderPath: '/selected' }
    })
    const handoff = finishProjectAddWithDefaultCheckout({
      repoId: 'project',
      source: 'local_folder_picker',
      selectedPath: '/selected',
      executionHostId: 'local',
      closeModal: () => store.setState({ activeModal: 'none', modalData: {} })
    })
    store.setState({
      activeWorktreeId: 'other::/newer',
      activeModal: 'new-workspace-composer',
      modalData: { initialRepoId: 'other' }
    })
    gate.resolve()
    await handoff
    expect(store.getState().activeModal).toBe('new-workspace-composer')
    expect(store.getState().modalData).toEqual({ initialRepoId: 'other' })
    expect(store.getState().activeWorktreeId).toBe('other::/newer')
    expect(harness.activate).not.toHaveBeenCalled()
    expect(harness.error).not.toHaveBeenCalled()
  })

  it('does not let an older onboarding completion supersede a newer handoff', async () => {
    const { store } = setup([checkout('/repo'), checkout('/selected'), checkout('/newer')])
    const gate = deferred<void>()
    harness.onboarding.mockReturnValueOnce(gate.promise)
    const handoff = finishProjectAddWithDefaultCheckout({
      repoId: 'project',
      source: 'local_folder_picker',
      selectedPath: '/selected',
      executionHostId: 'local',
      closeModal: () => store.setState({ activeModal: 'none', modalData: {} })
    })
    await open('/newer', 'local')
    harness.activate.mockClear()
    gate.resolve()
    await handoff
    expect(harness.activate).not.toHaveBeenCalled()
  })

  it('opens the deepest hidden checkout and preserves unrelated hidden siblings', async () => {
    const { store, persisted } = setup([
      checkout('/repo'),
      checkout('/repo/nested', { visible: false }),
      checkout('/sibling', { visible: false })
    ])
    await open('/repo/nested/src', 'local')
    expect(harness.activate).toHaveBeenCalledWith('project::/repo/nested', {
      navigationIntent: 'user-open',
      initialCwd: '/repo/nested/src',
      executionHostId: 'local'
    })
    expect(persisted.get('local')?.importedExternalWorktreePaths).toEqual(['/repo/nested'])
    expect(persisted.get('local')?.externalWorktreeVisibility).toBeUndefined()
    expect(store.getState().worktreesByRepo.project.map((row) => row.path)).toEqual([
      '/repo',
      '/repo/nested'
    ])
  })

  it.each(['/unmatched', '/repo/../sibling'])(
    'does not substitute the main checkout for %s',
    async (path) => {
      setup([checkout('/repo')])
      await open(path, 'local')
      expect(harness.activate).not.toHaveBeenCalled()
    }
  )

  it('retains saved intent and offers a working retry when confirmation fails', async () => {
    const { store, persisted } = setup([
      checkout('/repo'),
      checkout('/selected', { visible: false })
    ])
    const refresh = store.getState().fetchWorktrees
    const confirmation = deferred<boolean>()
    let retry: (() => void) | undefined
    harness.error.mockImplementation((_message, options) => {
      retry = options.action?.onClick
    })
    harness.subscribe.mockImplementation((listener) => store.subscribe(listener))
    const scan = vi.spyOn(store.getState(), 'fetchWorktrees')
    scan.mockImplementationOnce(refresh).mockImplementationOnce(() => confirmation.promise)
    const handoff = open('/selected', 'local')
    await vi.waitFor(() =>
      expect(persisted.get('local')?.importedExternalWorktreePaths).toEqual(['/selected'])
    )
    confirmation.resolve(false)
    await handoff
    expect(persisted.get('local')?.importedExternalWorktreePaths).toEqual(['/selected'])
    expect(harness.activate).not.toHaveBeenCalled()
    expect(retry).toEqual(expect.any(Function))
    retry!()
    await vi.waitFor(() =>
      expect(harness.activate).toHaveBeenCalledWith('project::/selected', {
        navigationIntent: 'user-open',
        executionHostId: 'local'
      })
    )
  })

  it('offers retry after a failed visibility write without importing siblings', async () => {
    const { persisted } = setup([
      checkout('/repo'),
      checkout('/selected', { visible: false }),
      checkout('/sibling', { visible: false })
    ])
    harness.persist.mockRejectedValueOnce(new Error('save unavailable'))
    let retry: (() => void) | undefined
    harness.error.mockImplementation((_message, options) => {
      retry = options.action?.onClick
    })
    await open('/selected', 'local')
    expect(persisted.get('local')?.importedExternalWorktreePaths).toBeUndefined()
    expect(harness.activate).not.toHaveBeenCalled()
    expect(retry).toEqual(expect.any(Function))
    retry!()
    await vi.waitFor(() =>
      expect(persisted.get('local')?.importedExternalWorktreePaths).toEqual(['/selected'])
    )
  })

  it('keeps later navigation even when the user returns while a scan is pending', async () => {
    const { store } = setup([checkout('/repo'), checkout('/selected', { visible: false })])
    const refresh = store.getState().fetchWorktrees
    const gate = deferred<boolean>()
    vi.spyOn(store.getState(), 'fetchWorktrees').mockImplementationOnce(async () => {
      await gate.promise
      return refresh('project', { executionHostId: 'local' })
    })
    const handoff = open('/selected', 'local')
    store.setState({ activeWorktreeId: 'project::/elsewhere' })
    store.setState({ activeWorktreeId: null })
    gate.resolve(true)
    await handoff
    expect(harness.activate).not.toHaveBeenCalled()
    expect(harness.error).not.toHaveBeenCalled()
  })

  it('does not clear the hidden-default preference on failure with a loaded main checkout', async () => {
    const { store } = setup([checkout('/repo')])
    await store.getState().fetchWorktrees('project', { executionHostId: 'local' })
    await open('/missing', 'local')
    expect(store.getState().hideDefaultBranchWorkspace).toBe(true)
    expect(harness.activate).not.toHaveBeenCalled()
  })

  it('accepts literal backslashes inside a POSIX checkout name', async () => {
    setup([checkout('/repo'), checkout('/repo/a\\..\\b')])
    await open('/repo/a\\..\\b/src', 'local')
    expect(harness.activate).toHaveBeenCalledWith('project::/repo/a\\..\\b', {
      navigationIntent: 'user-open',
      initialCwd: '/repo/a\\..\\b/src',
      executionHostId: 'local'
    })
  })

  /** Holds the handoff's first host read until the returned gate opens, then answers ok or failed. */
  function holdFirstScan(store: ReturnType<typeof setup>['store']) {
    const refresh = store.getState().fetchWorktrees
    const gate = deferred<boolean>()
    vi.spyOn(store.getState(), 'fetchWorktrees').mockImplementationOnce(async (...args) =>
      (await gate.promise) ? refresh(...args) : false
    )
    return gate
  }

  const visibleTabChanges: [string, Partial<AppState>][] = [
    ['terminal tab', { activeTabId: 'terminal-2' }],
    ['browser tab', { activeTabType: 'browser', activeBrowserTabId: 'browser-1' }]
  ]

  describe.each(visibleTabChanges)('picking another %s in the same workspace', (_tab, change) => {
    it.each([
      ['succeed', true],
      ['fail', false]
    ])('stands the handoff down when it would %s', async (_outcome, succeeds) => {
      const { store } = setup([checkout('/repo'), checkout('/selected', { visible: false })])
      store.setState({ activeWorktreeId: 'project::/repo', activeTabId: 'terminal-1' })
      const gate = holdFirstScan(store)
      const handoff = open('/selected', 'local')
      store.setState(change)
      gate.resolve(succeeds)
      await handoff
      expect(harness.activate).not.toHaveBeenCalled()
      expect(harness.error).not.toHaveBeenCalled()
    })

    it('stands an explicit Retry down too', async () => {
      const { store } = setup(
        [checkout('/repo'), checkout('/selected', { visible: false })],
        [repo],
        true
      )
      store.setState({ activeWorktreeId: 'project::/repo', activeTabId: 'terminal-1' })
      let retry: (() => void) | undefined
      harness.error.mockImplementation((_message, options) => {
        retry = options.action?.onClick
      })
      await open('/selected', 'local')
      expect(harness.error).toHaveBeenCalledTimes(1)
      const gate = holdFirstScan(store)
      retry?.()
      store.setState(change)
      gate.resolve(true)
      // Retry is fire-and-forget; let its held read settle.
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(harness.activate).not.toHaveBeenCalled()
      expect(harness.error).toHaveBeenCalledTimes(1)
    })
  })

  describe('choosing another page in the visible Browser tab', () => {
    const browserOn = (pageId: string, url = 'https://example.test/') => ({
      activeWorktreeId: 'project::/repo',
      activeTabType: 'browser' as const,
      activeBrowserTabId: 'browser-1',
      browserTabsByWorktree: {
        'project::/repo': [
          { id: 'browser-1', worktreeId: 'project::/repo', activePageId: pageId, url }
        ]
      }
    })
    const show = (store: ReturnType<typeof setup>['store'], state: object) =>
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the intent reads only these Browser workspace fields.
      store.setState(state as Partial<AppState>)

    it.each([
      ['succeed', true],
      ['fail', false]
    ])('stands the handoff down when it would %s', async (_outcome, succeeds) => {
      const { store } = setup([checkout('/repo'), checkout('/selected', { visible: false })])
      show(store, browserOn('page-1'))
      const gate = holdFirstScan(store)
      const handoff = open('/selected', 'local')
      show(store, browserOn('page-2'))
      gate.resolve(succeeds)
      await handoff
      expect(harness.activate).not.toHaveBeenCalled()
      expect(harness.error).not.toHaveBeenCalled()
    })

    it('stands an explicit Retry down too, and lets an undisturbed Retry open', async () => {
      const { store, recover } = setup(
        [checkout('/repo'), checkout('/selected', { visible: false })],
        [repo],
        true
      )
      show(store, browserOn('page-1'))
      let retry: (() => void) | undefined
      harness.error.mockImplementation((_message, options) => {
        retry = options.action?.onClick
      })
      await open('/selected', 'local')
      const disturbed = holdFirstScan(store)
      retry?.()
      show(store, browserOn('page-2'))
      disturbed.resolve(true)
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(harness.activate).not.toHaveBeenCalled()
      expect(harness.error).toHaveBeenCalledTimes(1)
      // Same page, edited URL: not a new choice, so an undisturbed Retry opens the checkout.
      recover()
      retry?.()
      show(store, browserOn('page-2', 'https://example.test/edited'))
      await vi.waitFor(() =>
        expect(harness.activate).toHaveBeenCalledWith('project::/selected', {
          navigationIntent: 'user-open',
          executionHostId: 'local'
        })
      )
    })
  })

  it('leaves selection and filters alone when the owner vanished during a held listing', async () => {
    const { store } = setup([checkout('/repo'), checkout('/selected', { visible: false })])
    store.setState({ activeRepoId: 'other', filterRepoIds: ['other'], showActiveOnly: true })
    const gate = holdFirstScan(store)
    const handoff = open('/selected', 'local')
    store.setState({ repos: [] })
    gate.resolve(false)
    await handoff
    const state = store.getState()
    expect(state.setActiveRepo).not.toHaveBeenCalled()
    expect(state.setFilterRepoIds).not.toHaveBeenCalled()
    expect(state.setShowActiveOnly).not.toHaveBeenCalled()
    expect(harness.error.mock.calls[0]?.[1]?.action).toBeUndefined()
  })

  it('reveals a live owner after a failure', async () => {
    const { store } = setup([checkout('/repo')])
    store.setState({ activeRepoId: 'other', filterRepoIds: ['other'], showActiveOnly: true })
    await open('/missing', 'local')
    const state = store.getState()
    expect(state.setActiveRepo).toHaveBeenCalledWith('project')
    expect(state.setFilterRepoIds).toHaveBeenCalledWith(['other', 'project'])
    expect(state.setShowActiveOnly).toHaveBeenCalledWith(false)
    expect(harness.error.mock.calls[0]?.[1]?.action).toBeDefined()
  })

  it('reports an owner removed during a held listing as unavailable, without Retry', async () => {
    const { store } = setup([checkout('/repo'), checkout('/selected', { visible: false })])
    const gate = holdFirstScan(store)
    const handoff = open('/selected', 'local')
    store.setState({ repos: [] })
    gate.resolve(false)
    await handoff
    expect(harness.error).toHaveBeenCalledTimes(1)
    const [, options] = harness.error.mock.calls[0]
    expect(options.description).toMatch(/could not be identified/)
    expect(options.action).toBeUndefined()
  })

  it.each([
    ['before completion starts', false],
    ['while onboarding is saved', true]
  ])(
    'leaves a same-type confirmation that replaced the add’s own alone (%s)',
    async (_moment, duringOnboarding) => {
      const { store } = setup([checkout('/repo'), checkout('/selected')])
      store.setState({
        activeModal: 'confirm-add-project-from-folder',
        modalData: { folderPath: '/selected' }
      })
      const intent = captureCheckoutHandoffIntent()
      const replacement = { folderPath: '/other' }
      const gate = deferred<void>()
      if (duringOnboarding) {
        harness.onboarding.mockReturnValueOnce(gate.promise)
      } else {
        store.setState({ modalData: replacement })
      }
      const closeModal = vi.fn()
      const handoff = finishProjectAddWithDefaultCheckout({
        repoId: 'project',
        source: 'local_folder_picker',
        selectedPath: '/selected',
        executionHostId: 'local',
        closeModal,
        intent
      })
      if (duringOnboarding) {
        store.setState({ modalData: replacement })
        gate.resolve()
      }
      await handoff
      intent.dispose()
      expect(closeModal).not.toHaveBeenCalled()
      expect(store.getState().modalData).toBe(replacement)
      expect(harness.activate).not.toHaveBeenCalled()
      expect(harness.error).not.toHaveBeenCalled()
    }
  )

  it.each([['local' as const], ['runtime:env' as const]])(
    'opens the selected sibling of a reused project and imports only it (%s)',
    async (hostId) => {
      const owner = hostId === 'local' ? repo : { ...repo, executionHostId: hostId }
      const host = hostId === 'local' ? {} : { hostId }
      const { persisted } = setup(
        [
          checkout('/repo', host),
          checkout('/sibling-a', { visible: false, ...host }),
          checkout('/sibling-b', { visible: false, ...host })
        ],
        [owner]
      )
      await open('/sibling-b', hostId)
      expect(harness.activate).toHaveBeenCalledWith('project::/sibling-b', {
        navigationIntent: 'user-open',
        executionHostId: hostId
      })
      expect(persisted.get(hostId)?.importedExternalWorktreePaths).toEqual(['/sibling-b'])
    }
  )

  describe('a nested import on a paired host completes within that host', () => {
    const local = repo
    const paired: Repo = { ...repo, executionHostId: 'runtime:env' }
    const onHost = { hostId: 'runtime:env' as const }
    it.each([
      ['local row first', [local, paired]],
      ['paired row first', [paired, local]]
    ])('opens only the picked sibling there (%s)', async (_order, repos) => {
      const { persisted } = setup(
        [
          checkout('/repo', onHost),
          checkout('/sibling-a', { visible: false, ...onHost }),
          checkout('/sibling-b', { visible: false, ...onHost })
        ],
        repos
      )
      const closeModal = vi.fn()
      const reported: unknown[] = []
      const scan: NestedRepoScanResult = {
        selectedPath: '/parent',
        selectedPathKind: 'non_git_folder',
        repos: [
          { path: '/unreadable', displayName: 'unreadable', depth: 1 },
          { path: '/sibling-b', displayName: 'sibling-b', depth: 1 }
        ],
        truncated: false,
        timedOut: false,
        stopped: false,
        durationMs: 0,
        maxDepth: 1,
        maxRepos: 10,
        timeoutMs: null
      }
      const { result } = renderHook(() => {
        const onGitRepoReady = useCompleteGitRepoAdd({ closeModal })
        return useAddRepoNestedImportFlow({
          nestedAttemptId: 'attempt',
          nestedScan: scan,
          nestedSelectedPaths: new Set(['/unreadable', '/sibling-b']),
          nestedRuntimeKind: null,
          nestedConnectionId: null,
          nestedGroupName: 'parent',
          nestedImportScanId: null,
          nestedRuntimeEnvironmentId: 'env',
          activeRuntimeEnvironmentId: 'env',
          closeModal,
          fetchWorktrees: async () => true,
          importNestedRepos: async () => ({
            projects: [
              { path: '/unreadable', status: 'failed', errorCode: 'import_failed' },
              { path: '/sibling-b', projectId: 'project', status: 'already-known' }
            ],
            importedCount: 0,
            alreadyKnownCount: 1,
            failedCount: 1
          }),
          getNestedRepoRuntimeKind: () => 'runtime',
          onGitRepoReady,
          setIsAdding: vi.fn(),
          takeNestedProjectReporter: () => (added) => reported.push(added)
        })
      })
      await result.current.handleImportNestedRepos('separate')
      expect(harness.activate).toHaveBeenCalledWith('project::/sibling-b', {
        navigationIntent: 'user-open',
        executionHostId: 'runtime:env'
      })
      expect(persisted.get('runtime:env')?.importedExternalWorktreePaths).toEqual(['/sibling-b'])
      expect(persisted.get('local')?.importedExternalWorktreePaths).toBeUndefined()
      expect(reported).toEqual([expect.objectContaining({ repo: expect.objectContaining(paired) })])
    })
  })

  describe('a same-type confirmation replacing the mounted dialog’s request', () => {
    const requestA = { folderPath: '/selected' }
    const requestB = { folderPath: '/other' }
    const added = { ...repo, executionHostId: 'local' as const }
    /** Mounts the dialog on request A, confirms it, and returns once the held step is reached. */
    async function confirmA(store: ReturnType<typeof setup>['store']) {
      store.setState({ activeModal: 'confirm-add-project-from-folder', modalData: requestA })
      const view = render(createElement(AddProjectFromFolderDialog))
      const button = await view.findByRole('button', { name: 'Add Project' })
      await act(async () => {
        button.click()
      })
    }
    function expectBIntact(store: ReturnType<typeof setup>['store']) {
      expect(store.getState().activeModal).toBe('confirm-add-project-from-folder')
      expect(store.getState().modalData).toBe(requestB)
      expect(harness.activate).not.toHaveBeenCalled()
      expect(harness.error).not.toHaveBeenCalled()
    }

    it.each([
      ['registers', { repo: added, selectedPath: '/selected' }],
      ['is not a Git repository', { error: 'Not a valid git repository: /selected' }],
      ['fails', { error: 'disk unavailable' }]
    ])('leaves B alone when A’s held add %s', async (outcome, reply) => {
      const { store } = setup([checkout('/repo'), checkout('/selected')], [])
      const addGate = deferred<unknown>()
      harness.add.mockReturnValueOnce(addGate.promise)
      await confirmA(store)
      await vi.waitFor(() => expect(harness.add).toHaveBeenCalled())
      await act(async () => {
        store.setState({ modalData: requestB })
        addGate.resolve(reply)
      })
      await new Promise((resolve) => setTimeout(resolve, 0))
      expectBIntact(store)
      // The registration itself still commits.
      expect(store.getState().repos.map((row) => row.id)).toEqual(
        outcome === 'registers' ? ['project'] : []
      )
    })

    it.each([['preliminary refresh'], ['onboarding save']])(
      'leaves B alone when A’s held %s finishes',
      async (step) => {
        const { store } = setup([checkout('/repo'), checkout('/selected')], [])
        harness.add.mockResolvedValueOnce({ repo: added, selectedPath: '/selected' })
        const gate = deferred<boolean>()
        if (step === 'onboarding save') {
          harness.onboarding.mockReturnValueOnce(gate.promise.then(() => undefined))
        } else {
          const refresh = store.getState().fetchWorktrees
          vi.spyOn(store.getState(), 'fetchWorktrees').mockImplementationOnce(async (...args) => {
            await gate.promise
            return refresh(...args)
          })
        }
        await confirmA(store)
        await vi.waitFor(() =>
          expect(store.getState().repos.map((row) => row.id)).toEqual(['project'])
        )
        await act(async () => {
          store.setState({ modalData: requestB })
          gate.resolve(true)
        })
        await new Promise((resolve) => setTimeout(resolve, 0))
        expectBIntact(store)
      }
    )
  })

  it('ignores a same-id remote checkout and refuses ambiguous owner inference', async () => {
    const remote = { ...repo, executionHostId: 'runtime:remote' as const }
    setup([checkout('/repo'), checkout('/remote', { hostId: 'runtime:remote' })], [repo, remote])
    await open('/remote', 'local')
    await open('/repo')
    expect(harness.activate).not.toHaveBeenCalled()
  })
})

it('preserves imports and delayed initial-card baselines through a failed scan', async () => {
  const { store, persisted } = setup([checkout('/repo')])
  const writeGate = deferred<Repo>()
  harness.persist.mockImplementationOnce(() => writeGate.promise)
  const first = store
    .getState()
    .updateRepo('project', { displayName: 'Renamed' }, { hostId: 'local' })
  const updateRepo: AppState['updateRepo'] = (id, updates) =>
    store.getState().updateRepo(id, updates, { hostId: 'local' })
  const importScan = deferred<boolean>()
  const imported = importNewExternalWorktreeInboxPaths({
    projectId: 'project',
    repo,
    worktreePaths: ['/selected'],
    updateRepo,
    fetchWorktrees: () => importScan.promise,
    setInboxState: vi.fn()
  })
  const card = keepImportedWorktreesHiddenCard({
    projectId: 'project',
    hiddenWorktreePaths: ['/hidden'],
    updateRepo,
    setCardState: vi.fn()
  })
  writeGate.resolve({ ...repo, displayName: 'Renamed' })
  await first
  await card
  importScan.resolve(false)
  await imported
  expect(persisted.get('local')?.importedExternalWorktreePaths).toEqual(['/selected'])
  expect(persisted.get('local')?.externalWorktreeInboxBaselinePaths).toEqual([
    '/selected',
    '/hidden'
  ])
})
