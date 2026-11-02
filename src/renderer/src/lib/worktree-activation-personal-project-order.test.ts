import { afterEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import { activateAndRevealWorktree } from './worktree-activation'
import { repo, worktree } from '../components/sidebar/worktree-list-groups-test-fixtures'
import { getDefaultUIState } from '../../../shared/constants'
import { mutatePersonalProjectOrder } from '../../../shared/personal-project-order-writes'
import { RecordProjectOpenParams } from '../../../shared/rpc-contract/personal-project-order-params'
import type { PendingWorktreeCreation } from './pending-worktree-creation'
import type { ExecutionHostId } from '../../../shared/execution-host'

vi.mock('../runtime/local-runtime-capabilities', () => ({
  ensureLocalRuntimeCapabilities: async () => ['ui.personalProjectOrder.v1']
}))

const initial = useAppStore.getState()
afterEach(() => {
  useAppStore.setState(initial, true)
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('successful deliberate personal project activation', () => {
  it.each<
    [
      string,
      ExecutionHostId | null,
      ExecutionHostId | undefined,
      ExecutionHostId,
      'hydrated' | 'ambiguous' | 'missing',
      number,
      string | null
    ]
  >([
    ['implicit local reopen', null, 'local', 'local', 'hydrated', 0, null],
    ['implicit SSH reopen', null, 'ssh:box', 'ssh:box', 'hydrated', 0, null],
    [
      'implicit SSH to local',
      null,
      'ssh:box',
      'local',
      'hydrated',
      1,
      '["ssh:box","ssh:box","repo:a"]'
    ],
    ['explicit selection owner', 'local', 'ssh:box', 'local', 'hydrated', 0, null],
    ['ambiguous owner', null, 'local', 'local', 'ambiguous', 1, null],
    ['missing owner', null, undefined, 'local', 'missing', 1, null]
  ])(
    'preserves actual previous ownership for %s with same-ID repos on two hosts',
    async (_label, selectionHost, ownerHost, targetHost, ownership, expectedCount, previousKey) => {
      let ui = getDefaultUIState()
      const runtime = {
        getUIState: () => ui,
        updateUIState: (patch: Partial<typeof ui>) => (ui = { ...ui, ...patch })
      }
      const openings: ReturnType<typeof RecordProjectOpenParams.parse>[] = []
      vi.stubGlobal('window', {
        api: {
          runtime: {
            call: async (request: { method: string; params?: unknown }) => {
              expect(request.method).toBe('ui.recordProjectOpen')
              const opening = RecordProjectOpenParams.parse(request.params)
              openings.push(opening)
              return {
                id: 'record',
                ok: true,
                result: mutatePersonalProjectOrder(runtime, opening)
              }
            }
          }
        }
      })
      const a = { ...repo, id: 'a', path: '/a', executionHostId: 'local' as const }
      const remoteA = { ...a, connectionId: 'box', executionHostId: 'ssh:box' as const }
      const b = { ...a, id: 'b', path: '/b' }
      const previous = { ...worktree, id: 'a::previous', repoId: 'a', hostId: ownerHost }
      const target = { ...previous, id: 'a::target', hostId: targetHost }
      const other = { ...worktree, id: 'b::target', repoId: 'b', hostId: 'local' as const }
      const previousRows = ownership === 'missing' ? [] : [previous]
      if (ownership === 'ambiguous') {
        previousRows.push({ ...previous, hostId: 'ssh:box' })
      }
      useAppStore.setState({
        repos: [a, remoteA, b],
        projects: [],
        projectHostSetups: [],
        worktreesByRepo: { a: [...previousRows, target], b: [other] },
        activeRepoId: a.id,
        activeWorktreeId: previous.id,
        activeWorkspaceExecutionHostId: selectionHost,
        activeView: 'terminal',
        tabsByWorktree: {},
        ptyIdsByTabId: {},
        everActivatedWorktreeIds: new Set([target.id, other.id]),
        recordWorktreeVisit: vi.fn(),
        markWorktreeVisited: vi.fn(),
        refreshGitHubForWorktreeIfStale: vi.fn(),
        getKnownWorktreeById: (id) => [target, other].find((entry) => entry.id === id),
        setActiveRepo: (id) => useAppStore.setState({ activeRepoId: id }),
        setActiveWorktree: (id, host, options) => {
          useAppStore.setState({
            ...options?.stateTransition?.(useAppStore.getState()).patch,
            activeWorktreeId: id,
            activeWorkspaceExecutionHostId: host ?? null
          })
          return true
        }
      })
      const deliberate = {
        navigationIntent: 'user-open' as const,
        providesInitialSurface: true,
        revealInSidebar: false,
        clearSidebarFilters: false,
        notifyHostRuntime: false
      }
      activateAndRevealWorktree(target.id, { ...deliberate, executionHostId: targetHost })
      activateAndRevealWorktree(target.id, { ...deliberate, executionHostId: targetHost })
      activateAndRevealWorktree(other.id, { ...deliberate, executionHostId: 'local' })
      activateAndRevealWorktree(other.id, { ...deliberate, executionHostId: 'local' })
      await vi.waitFor(() =>
        expect(ui.personalProjectOrder?.projects['["local","local","repo:b"]'].openCount).toBe(1)
      )
      const targetKey = JSON.stringify([targetHost, targetHost, 'repo:a'])
      expect(ui.personalProjectOrder?.projects[targetKey]?.openCount ?? 0).toBe(expectedCount)
      expect(openings).toHaveLength(expectedCount + 1)
      if (expectedCount) {
        expect(openings[0].previousProjectKey).toBe(previousKey)
      }
      expect(openings.at(-1)?.previousProjectKey).toBe(targetKey)
    }
  )

  it('counts completed cross-project opens and ignores pending, failed, background and same-project transitions', async () => {
    let ui = getDefaultUIState()
    const runtime = {
      getUIState: () => ui,
      updateUIState: (patch: Partial<typeof ui>) => (ui = { ...ui, ...patch })
    }
    const call = vi.fn(async (request: { method: string; params?: unknown }) => ({
      id: 'record',
      ok: true,
      result:
        request.method === 'ui.recordProjectOpen'
          ? mutatePersonalProjectOrder(runtime, RecordProjectOpenParams.parse(request.params))
          : { ui }
    }))
    vi.stubGlobal('window', { api: { runtime: { call } } })
    const a = { ...repo, id: 'a', path: '/a', executionHostId: 'local' as const }
    const b = { ...repo, id: 'b', path: '/b', executionHostId: 'local' as const }
    const wa = { ...worktree, id: 'a::/a/one', repoId: 'a', path: '/a/one' }
    const wa2 = { ...wa, id: 'a::/a/two', path: '/a/two' }
    const wb = { ...worktree, id: 'b::/b/one', repoId: 'b', path: '/b/one' }
    useAppStore.setState({
      repos: [a, b],
      projects: [],
      projectHostSetups: [],
      worktreesByRepo: { a: [wa, wa2], b: [wb] },
      activeRepoId: 'b',
      activeWorktreeId: wb.id,
      activeView: 'terminal',
      activeWorkspaceExecutionHostId: 'local',
      tabsByWorktree: {},
      ptyIdsByTabId: {},
      everActivatedWorktreeIds: new Set([wa.id, wa2.id, wb.id]),
      recordWorktreeVisit: vi.fn(),
      markWorktreeVisited: vi.fn(),
      refreshGitHubForWorktreeIfStale: vi.fn(),
      getKnownWorktreeById: (id) => [wa, wa2, wb].find((entry) => entry.id === id),
      setActiveRepo: (id) => useAppStore.setState({ activeRepoId: id }),
      setActiveWorktree: (id, host, options) => {
        useAppStore.setState({
          ...options?.stateTransition?.(useAppStore.getState()).patch,
          activeWorktreeId: id,
          activeWorkspaceExecutionHostId: host ?? null
        })
        return true
      }
    })
    const deliberate = {
      navigationIntent: 'user-open' as const,
      providesInitialSurface: true,
      revealInSidebar: false,
      clearSidebarFilters: false,
      executionHostId: 'local' as const
    }
    const creation: PendingWorktreeCreation = {
      creationId: 'create-a',
      worktreeId: wa.id,
      phase: 'creating',
      status: 'creating',
      startedAt: 1,
      indeterminate: false,
      loaderVisible: false,
      request: {
        repoId: a.id,
        name: 'one',
        setupDecision: 'inherit',
        agent: null,
        pendingFirstAgentMessageRename: false,
        note: '',
        startupPlan: null,
        quickPrompt: '',
        quickTelemetry: null
      }
    }
    useAppStore.getState().beginPendingWorktreeCreation(creation)
    expect(activateAndRevealWorktree(wa.id, deliberate)).toEqual({ primaryTabId: null })
    activateAndRevealWorktree(wa.id, deliberate)
    await new Promise<void>((resolve) => queueMicrotask(resolve))
    expect(useAppStore.getState().activeWorktreeId).toBe(wb.id)
    expect(useAppStore.getState().activePendingCreationId).toBe(creation.creationId)
    expect(useAppStore.getState().pendingWorktreeCreations[creation.creationId].loaderVisible).toBe(
      true
    )
    expect(call).not.toHaveBeenCalled()
    useAppStore.getState().updatePendingWorktreeCreation(creation.creationId, { status: 'error' })
    useAppStore.getState().removePendingWorktreeCreation(creation.creationId)
    await new Promise<void>((resolve) => queueMicrotask(resolve))
    expect(ui.personalProjectOrder).toBeUndefined()
    useAppStore.getState().beginPendingWorktreeCreation(creation)
    activateAndRevealWorktree(wa.id, { ...deliberate, worktreeCreationId: creation.creationId })
    await vi.waitFor(() => expect(ui).toHaveProperty('personalProjectOrder'))
    useAppStore.getState().removePendingWorktreeCreation(creation.creationId)
    const first = ui.personalProjectOrder
    expect(first).toMatchObject({ projects: { '["local","local","repo:a"]': { openCount: 1 } } })
    activateAndRevealWorktree(wa.id, deliberate)
    activateAndRevealWorktree(wa2.id, deliberate)
    expect(activateAndRevealWorktree('missing', deliberate)).toBe(false)
    activateAndRevealWorktree(wb.id, {
      providesInitialSurface: true,
      revealInSidebar: false,
      clearSidebarFilters: false
    })
    await new Promise<void>((resolve) => queueMicrotask(resolve))
    expect(ui.personalProjectOrder).toEqual(first)
    activateAndRevealWorktree(wa.id, deliberate)
    await vi.waitFor(() =>
      expect(ui.personalProjectOrder?.projects['["local","local","repo:a"]'].openCount).toBe(2)
    )
    useAppStore.setState({ setActiveWorktree: () => false })
    activateAndRevealWorktree(wb.id, deliberate)
    await new Promise<void>((resolve) => queueMicrotask(resolve))
    expect(ui.personalProjectOrder?.projects['["local","local","repo:b"]']).toBeUndefined()
  })
})
