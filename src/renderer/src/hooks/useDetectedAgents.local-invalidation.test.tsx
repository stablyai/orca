import { installLocalAgentInventoryWorkCorpus } from './local-agent-inventory-work-corpus.test-fixture'
import { exerciseLocalAgentProjectGitRetarget } from './local-agent-project-git-retarget.test-fixture'
import {
  exerciseInvalidatedLocalAgentFirstProbe,
  exerciseLocalAgentProjectRuntimeRetarget,
  exerciseFailedLocalAgentFirstProbeRetry,
  exerciseCachedLocalAgentCapabilities,
  exerciseNativeAgentRecoveryAlongsideWslInventories
} from './local-agent-inventory-lifecycle.test-fixture'
// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { makeDetectedResult } from '@/store/slices/worktrees-detected-listing-fixtures'
import * as runtime from '../../../shared/project-execution-runtime'
import * as folderHost from '../../../shared/folder-workspace-execution-host'
import * as projectIndex from '@/lib/local-runtime-project-index'
import * as preflight from '@/lib/local-preflight-context'
import * as routeInput from '@/lib/agent-launch-route-input'
import * as menuRows from '@/lib/new-tab-agent-menu-rows'
import * as menuSelection from '@/lib/agent-menu-selection'
import * as agentCatalog from '@/lib/agent-catalog'
import { resetWindowsTerminalCapabilitiesForTests } from '@/lib/windows-terminal-capabilities'
import { useLocalAgentPreflightContext } from './useLocalAgentPreflightContext'
import { useAppStore } from '@/store'
import { useAgentMenuObservation } from '@/components/tab-bar/use-new-tab-agent-menu-rows'
import { resetHostStructuredAgentsForTests } from '@/runtime/host-structured-agents'
import { setLocalRuntimeCapabilitiesForTests } from '@/runtime/local-runtime-capabilities'
import { FLOATING_TERMINAL_WORKTREE_ID, getDefaultSettings } from '../../../shared/constants'
import type { TuiAgent } from '../../../shared/tui-agent'
import { useDetectedAgents, type AgentDetectionTarget } from './useDetectedAgents'

const initialState = useAppStore.getInitialState()
const detectAgents = vi.fn()
const updateProject = vi.fn()
const refreshAgents = vi.fn<Window['api']['preflight']['refreshAgents']>()

beforeEach(() => {
  resetWindowsTerminalCapabilitiesForTests()
  useAppStore.setState(initialState, true)
  useAppStore.getState().clearLocalDetectedAgents()
  detectAgents.mockReset().mockResolvedValue(['codex'])
  refreshAgents.mockReset().mockResolvedValue({
    agents: ['codex'],
    addedPathSegments: [],
    shellHydrationOk: true,
    pathSource: 'shell_hydrate',
    pathFailureReason: 'none'
  })
  updateProject.mockReset()
  Object.assign(window, {
    api: {
      preflight: { detectAgents, refreshAgents },
      projects: { update: updateProject },
      platform: { get: () => ({ platform: 'win32' }) }
    }
  })
})

afterEach(() => {
  resetWindowsTerminalCapabilitiesForTests()
  cleanup()
  resetHostStructuredAgentsForTests()
  setLocalRuntimeCapabilitiesForTests(null)
  useAppStore.getState().clearLocalDetectedAgents()
  useAppStore.setState(initialState, true)
})

const localTargets: AgentDetectionTarget[] = [
  { kind: 'local' },
  { kind: 'local', worktreeId: FLOATING_TERMINAL_WORKTREE_ID, contextKey: 'host' }
]

it.each(localTargets)('restarts an invalidated first probe for $worktreeId', async (target) => {
  await exerciseInvalidatedLocalAgentFirstProbe(target, detectAgents)
})

it('retargets a mounted first load when the project switches to WSL', async () => {
  await exerciseLocalAgentProjectRuntimeRetarget(detectAgents, updateProject)
})

it('retargets mounted inventories and menu after a Git-only WSL project update', async () => {
  await exerciseLocalAgentProjectGitRetarget(detectAgents, updateProject)
})

it.each(localTargets)(
  'keeps a failed first inventory unknown until Retry for $worktreeId',
  async (target) => {
    await exerciseFailedLocalAgentFirstProbeRetry(target, detectAgents)
  }
)

it('bounds repeated inventory work at N/10N and renders only the observed context', async () => {
  const context = await import('@/lib/local-preflight-context')
  const { localAgentInventoryContextKey } = await import('@/lib/local-preflight-context-key')
  const resolution = vi.spyOn(runtime, 'resolveProjectExecutionRuntime')
  const selection = vi.spyOn(preflight, 'selectLocalAgentPreflightInput')
  const candidates = vi.spyOn(folderHost, 'findFolderWorkspaceCandidateRepos')
  const folderQualifications = vi.spyOn(folderHost, 'resolveQualifiedFolderWorkspaceResult')
  const folderAssociations = vi.spyOn(folderHost, 'findLocalFolderWorkspaceRuntimeRepo')
  let indexing = false
  let indexRows = 0
  const getIndexed = projectIndex.getIndexedLocalRuntimeProject
  const indexReads = vi
    .spyOn(projectIndex, 'getIndexedLocalRuntimeProject')
    .mockImplementation((...args) => {
      indexing = true
      try {
        return getIndexed(...args)
      } finally {
        indexing = false
      }
    })
  const measured: number[] = []
  for (const count of [10, 100]) {
    let projectRows = 0
    let projectFixtureCopies = 0
    let workspaceRows = 0
    let folderRows = 0
    const { repos, catalog, projects, worktrees } = installLocalAgentInventoryWorkCorpus(count, {
      projectRead: () => {
        projectRows += 1
        if (indexing) {
          indexRows += 1
        }
      },
      projectCopy: () => {
        projectFixtureCopies += 1
      },
      workspaceRead: () => {
        workspaceRows += 1
      },
      folderRead: () => {
        folderRows += 1
      }
    })
    const keys = worktrees.map((wt) =>
      localAgentInventoryContextKey(
        context.getLocalAgentPreflightContext(useAppStore.getState(), undefined, undefined, wt.id)
      )
    )
    useAppStore.setState({
      localDetectedAgentIdsByContext: Object.fromEntries(keys.map((key) => [key, ['claude']]))
    })
    let reads = 0
    const failures = (entries: Record<string, boolean>) =>
      new Proxy(entries, {
        get(target, key) {
          reads += 1
          return typeof key === 'string' ? target[key] : undefined
        }
      })
    useAppStore.setState({ localAgentInventoryFailedByContext: failures({}) })
    const renders = Array<number>(count).fill(0)
    const mounted = worktrees.slice(0, count).map((wt, index) =>
      renderHook(() => {
        renders[index] += 1
        return useDetectedAgents({ kind: 'local', worktreeId: wt.id })
      })
    )
    let folderRenders = 0
    const folder = renderHook(() => {
      folderRenders += 1
      return useLocalAgentPreflightContext('folder:folder')
    })
    await act(async () => {})
    expect(folder.result.current?.projectRuntime).toMatchObject({ status: 'resolved' })
    renders.fill(0)
    folderRenders = 0
    reads = projectRows = workspaceRows = indexRows = folderRows = 0
    projectFixtureCopies = 0
    resolution.mockClear()
    selection.mockClear()
    candidates.mockClear()
    folderQualifications.mockClear()
    folderAssociations.mockClear()
    const unrelated = [
      () => useAppStore.setState({ isDetectingAgents: false }),
      () =>
        useAppStore.setState({
          detectedWorktreesByRepo: { otherHost: makeDetectedResult('otherHost', []) }
        }),
      () => useAppStore.setState({ remoteDetectedAgentIds: { anotherHost: ['codex'] } }),
      () =>
        useAppStore.setState({
          localAgentInventoryFailedByContext: failures({ anotherContext: true })
        }),
      () =>
        useAppStore.setState((s) => ({
          settings: { ...(s.settings ?? getDefaultSettings('/tmp')), terminalFontSize: 15 }
        }))
    ]
    for (const publish of unrelated) {
      await act(async () => {
        publish()
      })
      expect(renders).toEqual(Array(count).fill(0))
      expect(folderRenders).toBe(0)
      expect(resolution).not.toHaveBeenCalled()
      expect(projectRows).toBe(0)
      expect(indexRows).toBe(0)
      expect(projectFixtureCopies).toBe(0)
      expect(folderRows).toBe(0)
      expect(candidates).not.toHaveBeenCalled()
      expect(folderQualifications).not.toHaveBeenCalled()
      expect(folderAssociations).not.toHaveBeenCalled()
    }
    measured.push(reads)
    const inputReads = selection.mock.calls.length
    expect(inputReads).toBeLessThanOrEqual(6 * (count + 1))
    // The producer is real; only its disk/RPC persistence boundary is replaced.
    const persistence = await import('@/store/slices/worktrees/metadata/worktree-meta-persist')
    const persist = vi.spyOn(persistence, 'persistWorktreeMeta').mockResolvedValue()
    const previousSource = useAppStore.getState().worktreesByRepo
    await act(async () => {
      useAppStore.getState().bumpWorktreeActivity(worktrees[count].id)
    })
    expect(useAppStore.getState().worktreesByRepo).not.toBe(previousSource)
    expect(persist).toHaveBeenCalledOnce()
    persist.mockRestore()
    expect(renders).toEqual(Array(count).fill(0))
    expect(folderRenders).toBe(0)
    expect(projectRows).toBe(0)
    expect(folderRows).toBe(0)
    expect(resolution).not.toHaveBeenCalled()
    expect(candidates).not.toHaveBeenCalled()
    expect(folderQualifications).not.toHaveBeenCalled()
    expect(folderAssociations).not.toHaveBeenCalled()
    // Shared worktree-index rebuild plus the producer's own reads, never M rebuilds.
    expect(workspaceRows).toBeLessThanOrEqual(8 * (count + 1))
    const activityRows = workspaceRows
    await act(async () => {
      useAppStore.setState((s) => ({
        folderWorkspaces: s.folderWorkspaces.map((entry) => ({ ...entry, lastActivityAt: 42 }))
      }))
    })
    expect(candidates).not.toHaveBeenCalled()
    expect(folderQualifications).not.toHaveBeenCalled()
    expect(folderAssociations).not.toHaveBeenCalled()
    expect(resolution).not.toHaveBeenCalled()
    expect(folderRenders).toBe(0)
    expect(folderRows).toBeGreaterThan(0)
    expect(folderRows).toBeLessThanOrEqual(4)
    const folderIndexRows = folderRows
    await act(async () => {
      useAppStore.setState((s) => ({
        projects: projects(s.projects.map((project) => ({ ...project })))
      }))
    })
    expect(projectRows).toBeGreaterThan(1000)
    expect(projectRows).toBeLessThanOrEqual(8000)
    const rebuiltProjectRows = indexRows
    const catalogAndCopyRows = projectRows - indexRows
    const rebuiltProjectFixtureCopies = projectFixtureCopies
    expect(rebuiltProjectFixtureCopies).toBe(1000)
    expect(indexRows).toBeGreaterThan(0)
    expect(indexRows).toBeLessThanOrEqual(5000)
    expect(resolution).not.toHaveBeenCalled()
    expect(renders).toEqual(Array(count).fill(0))
    expect(folderQualifications).not.toHaveBeenCalled()
    expect(folderAssociations).not.toHaveBeenCalled()
    // A real selected runtime changes only its owner; the new catalog index is shared.
    await act(async () => {
      useAppStore.setState((s) => ({
        projects: projects(
          s.projects.map((project) =>
            project.id === catalog.projects[999 - count].id
              ? { ...project, localWindowsRuntimePreference: { kind: 'wsl', distro: 'Debian' } }
              : project
          )
        )
      }))
    })
    expect(resolution.mock.calls.length).toBeGreaterThan(0)
    expect(resolution.mock.calls.every(([input]) => input.projectId === worktrees[0].repoId)).toBe(
      true
    )
    expect(detectAgents).toHaveBeenLastCalledWith(
      expect.objectContaining({
        projectRuntime: expect.objectContaining({
          runtime: expect.objectContaining({ distro: 'Debian' })
        })
      })
    )
    expect(mounted[0].result.current.detectedIds).toEqual(['codex'])
    expect(renders.slice(1)).toEqual(Array(count - 1).fill(0))
    expect(folderRenders).toBe(0)
    expect(folderQualifications).not.toHaveBeenCalled()
    expect(folderAssociations).not.toHaveBeenCalled()
    // Restore the original key without relying on the acquisition result.
    await act(async () => {
      useAppStore.setState({
        projects: projects(
          catalog.projects.map((project) => ({
            ...project,
            localWindowsRuntimePreference: { kind: 'wsl', distro: 'Ubuntu' }
          }))
        )
      })
    })
    resolution.mockClear()
    renders.fill(0)
    process.stdout.write(
      `${JSON.stringify({ metric: 'context-selected-work', consumers: count, projects: 1000, inputReads, expensiveIrrelevant: 0, projectIndexRows: rebuiltProjectRows, catalogAndCopyRows, projectFixtureCopies: rebuiltProjectFixtureCopies, activityRows, folderIndexRows, unaffectedRenders: 0 })}\n`
    )
    await act(async () => {
      useAppStore.setState({
        localAgentInventoryFailedByContext: failures({ [keys[0]]: true })
      })
    })
    expect(renders[0]).toBeGreaterThan(0)
    expect(renders.slice(1)).toEqual(Array(count - 1).fill(0))
    expect(mounted[0].result.current).toMatchObject({
      detectedIds: ['claude'],
      detectionFailed: true
    })
    await act(async () => {
      useAppStore.setState({ isRefreshingLocalAgentsByContext: { [keys[0]]: true } })
    })
    expect(mounted[0].result.current.detectionFailed).toBe(false)
    await act(async () => {
      useAppStore.setState({ isRefreshingLocalAgentsByContext: {} })
    })
    expect(mounted[0].result.current.detectionFailed).toBe(true)
    expect(resolution).not.toHaveBeenCalled()
    expect(folderQualifications).not.toHaveBeenCalled()
    expect(folderAssociations).not.toHaveBeenCalled()
    // Same selector follows real folder path, owner and candidate-cardinality changes.
    candidates.mockClear()
    folderQualifications.mockClear()
    folderAssociations.mockClear()
    await act(async () => {
      useAppStore.setState((s) => ({
        projects: s.projects.map((project, index) =>
          index === 0 ? { ...project, localWindowsRuntimePreference: undefined } : project
        ),
        folderWorkspaces: s.folderWorkspaces.map((entry) => ({
          ...entry,
          folderPath: String.raw`\\wsl$\Debian\folder`
        }))
      }))
    })
    expect(folder.result.current?.wslDistro).toBe('Debian')
    const currentFolderState = useAppStore.getState()
    expect(
      folderQualifications.mock.results.some((result, index) => {
        const [source, folderId] = folderQualifications.mock.calls[index]
        return (
          result.type === 'return' &&
          result.value.kind === 'selected' &&
          result.value.value.workspace === currentFolderState.folderWorkspaces[0] &&
          folderId === 'folder' &&
          source.folderWorkspaces === currentFolderState.folderWorkspaces &&
          source.projectGroups === currentFolderState.projectGroups &&
          source.repos === currentFolderState.repos
        )
      })
    ).toBe(true)
    expect(
      folderAssociations.mock.results.some((result, index) => {
        const [source, folderId, selectedFolder] = folderAssociations.mock.calls[index]
        return (
          result.type === 'return' &&
          result.value === currentFolderState.repos[0] &&
          folderId === 'folder' &&
          selectedFolder?.id === currentFolderState.folderWorkspaces[0].id &&
          source.folderWorkspaces === currentFolderState.folderWorkspaces &&
          source.projectGroups === currentFolderState.projectGroups &&
          source.repos === currentFolderState.repos
        )
      })
    ).toBe(true)
    await act(async () => {
      useAppStore.setState((s) => ({
        folderWorkspaces: s.folderWorkspaces.map((entry) => ({
          ...entry,
          executionHostId: 'ssh:other'
        }))
      }))
    })
    expect(folder.result.current).toBeUndefined()
    await act(async () => {
      useAppStore.setState((s) => ({
        folderWorkspaces: s.folderWorkspaces.map((entry) => ({
          ...entry,
          executionHostId: 'local'
        }))
      }))
    })
    expect(folder.result.current?.wslDistro).toBe('Debian')
    await act(async () => {
      useAppStore.setState((s) => ({
        repos: s.repos.map((repo, index) =>
          index === 1 ? { ...repo, projectGroupId: 'folder-group' } : repo
        )
      }))
    })
    expect(folder.result.current).toBeUndefined()
    folder.unmount()
    mounted.forEach((hook) => hook.unmount())
    // The ordinary open row path includes both independent before-equality producers.
    useAppStore.setState({
      repos,
      projects: projects(
        catalog.projects.map((project) => ({
          ...project,
          localWindowsRuntimePreference: { kind: 'wsl', distro: 'Ubuntu' }
        }))
      ),
      worktreesByRepo: Object.fromEntries(worktrees.map((wt) => [wt.repoId, [wt]])),
      localAgentInventoryFailedByContext: failures({}),
      localDetectedAgentIdsByContext: Object.fromEntries(
        keys.flatMap((key) => [
          [key, ['claude']],
          [`${key}\u0000all-agents`, ['claude']]
        ])
      ),
      settings: getDefaultSettings('/tmp')
    })
    setLocalRuntimeCapabilitiesForTests([])
    const imperative = vi.spyOn(preflight, 'getLocalAgentPreflightContext')
    const projectRuntime = vi.spyOn(preflight, 'getLocalProjectExecutionRuntimeContext')
    const routes = vi.spyOn(routeInput, 'buildAgentLaunchRouteInput')
    const rows = vi.spyOn(menuRows, 'buildNewTabAgentMenuRows')
    const metadata = vi.spyOn(agentCatalog, 'getAgentCatalog')
    const selections = vi.spyOn(menuSelection, 'resolveAgentMenuSelection')
    const menuRenders = Array<number>(count).fill(0)
    const menus = worktrees.slice(0, count).map((wt, index) =>
      renderHook(
        ({ id, open }) => {
          menuRenders[index]++
          return useAgentMenuObservation(id, open, { kind: 'local', worktreeId: id }, false, {
            wakeOnOpen: true
          })
        },
        { initialProps: { id: wt.id, open: true } }
      )
    )
    await act(async () => {})
    expect(menus.every((menu) => menu.result.current.model.state === 'settled')).toBe(true)
    const clearMenuWork = () => {
      menuRenders.fill(0)
      reads = projectRows = workspaceRows = indexRows = folderRows = projectFixtureCopies = 0
      for (const spy of [
        resolution,
        selection,
        candidates,
        imperative,
        projectRuntime,
        routes,
        rows,
        metadata,
        selections,
        folderQualifications,
        folderAssociations
      ]) {
        spy.mockClear()
      }
    }
    const selectedKeys = keys.flatMap((key) => [key, `${key}\u0000all-agents`])
    const selectedBefore = selectedKeys.map((key) =>
      useAppStore.getState().readLocalAgentInventoryByKey(key)
    )
    clearMenuWork()
    const menuPublications = [
      () => useAppStore.setState({ settingsSearchQuery: 'unused search' }),
      () => useAppStore.setState({ remoteDetectedAgentIds: { anotherHost: ['codex'] } }),
      () =>
        useAppStore.setState((state) => ({
          localAgentInventoryFailedByContext: failures({
            ...state.localAgentInventoryFailedByContext,
            unused: true
          })
        }))
    ]
    for (const publish of menuPublications) {
      clearMenuWork()
      await act(async () => publish())
      const work = {
        consumers: count,
        open: true,
        scalarReads: reads,
        inputs: selection.mock.calls.length,
        wakeContext: imperative.mock.calls.length,
        hostProjectRuntime: projectRuntime.mock.calls.length,
        sharedRuntime: resolution.mock.calls.length,
        routes: routes.mock.calls.length,
        projectRows,
        indexRows,
        workspaceRows,
        folderRows,
        projectFixtureCopies,
        candidateBuilders: rows.mock.calls.length,
        candidateVisits: rows.mock.calls.reduce(
          (sum, [input]) => sum + (input.configurationCommandCandidates?.length ?? 0),
          0
        ),
        rowMetadata: rows.mock.results.reduce(
          (sum, result) => sum + (result.type === 'return' ? result.value.length : 0),
          0
        ),
        metadata: metadata.mock.calls.length,
        selections: selections.mock.calls.length,
        renders: [...menuRenders]
      }
      process.stdout.write(`${JSON.stringify({ metric: 'active-ordinary-menu', ...work })}\n`)
      expect.soft(work.wakeContext, 'F33 imperative context before selected failure').toBe(0)
      expect.soft(work.hostProjectRuntime, 'F35 unused route runtime before host equality').toBe(0)
      expect.soft(work.sharedRuntime).toBe(0)
      expect.soft(folderQualifications).not.toHaveBeenCalled()
      expect.soft(folderAssociations).not.toHaveBeenCalled()
      expect.soft(work.routes).toBe(0)
      expect
        .soft([projectRows, indexRows, workspaceRows, folderRows, projectFixtureCopies])
        .toEqual([0, 0, 0, 0, 0])
      expect
        .soft([
          work.candidateBuilders,
          work.candidateVisits,
          work.rowMetadata,
          work.metadata,
          work.selections
        ])
        .toEqual([0, 0, 0, 0, 0])
      expect.soft(menuRenders).toEqual(Array(count).fill(0))
      expect.soft(work.inputs).toBeLessThanOrEqual(12 * count)
      expect.soft(work.scalarReads).toBeLessThanOrEqual(12 * count)
      expect(
        selectedKeys.map((key) => useAppStore.getState().readLocalAgentInventoryByKey(key))
      ).toEqual(selectedBefore)
    }
    const emptyIds: TuiAgent[] = []
    await act(async () =>
      useAppStore.setState((state) => ({
        localDetectedAgentIdsByContext: {
          ...state.localDetectedAgentIdsByContext,
          [keys[count - 1]]: emptyIds
        }
      }))
    )
    const retainedArrays = menus.map((menu) => menu.result.current.detection.detectedIds)
    expect(retainedArrays[count - 1]).toBe(emptyIds)
    for (const [index, menu] of menus.entries()) {
      menu.rerender({ id: worktrees[index].id, open: false })
    }
    await act(async () => {})
    clearMenuWork()
    await act(async () => useAppStore.setState({ settingsSearchQuery: 'closed unused search' }))
    process.stdout.write(
      `${JSON.stringify({ metric: 'closed-ordinary-menu', consumers: count, inputs: selection.mock.calls.length, scalarReads: reads, wakeContext: imperative.mock.calls.length, hostProjectRuntime: projectRuntime.mock.calls.length, sharedRuntime: resolution.mock.calls.length, workspaceRows, renders: menuRenders })}\n`
    )
    expect.soft(imperative).not.toHaveBeenCalled()
    expect.soft(projectRuntime).not.toHaveBeenCalled()
    expect.soft(resolution).not.toHaveBeenCalled()
    expect.soft(workspaceRows).toBe(0)
    expect.soft(folderQualifications).not.toHaveBeenCalled()
    expect.soft(folderAssociations).not.toHaveBeenCalled()
    expect.soft(menuRenders).toEqual(Array(count).fill(0))
    expect(selection.mock.calls.length).toBeLessThanOrEqual(12 * count)
    expect(reads).toBeLessThanOrEqual(12 * count)
    clearMenuWork()
    await act(async () => useAppStore.setState({ detectedAgentIds: ['gemini'] }))
    const closedLegacyWork = {
      metric: 'closed-menu-divergent-legacy',
      consumers: count,
      inputs: selection.mock.calls.length,
      scalarReads: reads,
      wakeContext: imperative.mock.calls.length,
      hostProjectRuntime: projectRuntime.mock.calls.length,
      sharedRuntime: resolution.mock.calls.length,
      routes: routes.mock.calls.length,
      projectRows,
      indexRows,
      workspaceRows,
      folderRows,
      projectFixtureCopies,
      candidates: rows.mock.calls.length,
      metadata: metadata.mock.calls.length,
      selections: selections.mock.calls.length,
      renders: [...menuRenders]
    }
    expect([
      imperative.mock.calls.length,
      projectRuntime.mock.calls.length,
      resolution.mock.calls.length,
      routes.mock.calls.length,
      projectRows,
      indexRows,
      workspaceRows,
      folderRows,
      projectFixtureCopies,
      rows.mock.calls.length,
      metadata.mock.calls.length,
      selections.mock.calls.length
    ]).toEqual(Array(12).fill(0))
    expect(folderQualifications).not.toHaveBeenCalled()
    expect(folderAssociations).not.toHaveBeenCalled()
    expect(menuRenders).toEqual(Array(count).fill(0))
    menus.forEach((menu, index) =>
      expect(menu.result.current.detection.detectedIds).toBe(retainedArrays[index])
    )
    expect(closedLegacyWork.inputs).toBeLessThanOrEqual(12 * count)
    expect(closedLegacyWork.scalarReads).toBeLessThanOrEqual(12 * count)
    process.stdout.write(`${JSON.stringify(closedLegacyWork)}\n`)
    const passiveWorktree = worktrees[count]
    const passiveProject = projectIndex.getIndexedLocalRuntimeProject(
      useAppStore.getState().projects,
      passiveWorktree.projectId ?? passiveWorktree.repoId,
      passiveWorktree.repoId
    )
    if (!passiveProject) {
      throw new Error('Expected the passive worktree project')
    }
    const spareIds = useAppStore.getState().localDetectedAgentIdsByContext[keys[count]]
    const passiveRequests = detectAgents.mock.calls.length
    menus[0].rerender({ id: passiveWorktree.id, open: false })
    expect(menus[0].result.current.detection.detectedIds).toBe(spareIds)
    expect(detectAgents).toHaveBeenCalledTimes(passiveRequests)
    const passiveColdKey = `${passiveWorktree.repoId}:wsl:Debian`
    expect(useAppStore.getState().localDetectedAgentIdsByContext[passiveColdKey]).toBeUndefined()
    clearMenuWork()
    await act(async () =>
      useAppStore.setState((state) => ({
        projects: projects(
          state.projects.map((project) =>
            project.id === passiveProject.id
              ? { ...project, localWindowsRuntimePreference: { kind: 'wsl', distro: 'Debian' } }
              : project
          )
        )
      }))
    )
    const passiveColdWork = {
      metric: 'closed-menu-current-cold-runtime',
      consumers: count,
      inputs: selection.mock.calls.length,
      scalarReads: reads,
      runtime: resolution.mock.calls.length,
      projectRows,
      indexRows,
      projectFixtureCopies,
      renders: [...menuRenders],
      addedRequests: detectAgents.mock.calls.length - passiveRequests
    }
    expect(menus[0].result.current.detection.detectedIds).toBeNull()
    expect(useAppStore.getState().detectedAgentIds).toEqual(['gemini'])
    expect(detectAgents).toHaveBeenCalledTimes(passiveRequests)
    expect(menuRenders[0]).toBeGreaterThan(0)
    expect(menuRenders.slice(1)).toEqual(Array(count - 1).fill(0))
    menus
      .slice(1)
      .forEach((menu, index) =>
        expect(menu.result.current.detection.detectedIds).toBe(retainedArrays[index + 1])
      )
    process.stdout.write(`${JSON.stringify(passiveColdWork)}\n`)
    await act(async () =>
      useAppStore.setState((state) => ({
        projects: projects(
          state.projects.map((project) =>
            project.id === passiveProject.id
              ? { ...project, localWindowsRuntimePreference: { kind: 'wsl', distro: 'Ubuntu' } }
              : project
          )
        )
      }))
    )
    expect(menus[0].result.current.detection.detectedIds).toBe(spareIds)
    expect(detectAgents).toHaveBeenCalledTimes(passiveRequests)
    for (const [index, menu] of menus.entries()) {
      menu.rerender({ id: worktrees[index].id, open: true })
    }
    await act(async () => {})
    clearMenuWork()
    await act(async () =>
      useAppStore.setState((state) => ({
        localAgentInventoryFailedByContext: failures({
          ...state.localAgentInventoryFailedByContext,
          [keys[0]]: true
        })
      }))
    )
    expect(menuRenders[0]).toBeGreaterThan(0)
    expect(menuRenders.slice(1)).toEqual(Array(count - 1).fill(0))
    expect(menus[0].result.current.detection.detectionFailed).toBe(true)
    await act(async () =>
      useAppStore.setState({ isRefreshingLocalAgentsByContext: { [keys[0]]: true } })
    )
    expect(menus[0].result.current.detection.detectionFailed).toBe(false)
    await act(async () => useAppStore.setState({ isRefreshingLocalAgentsByContext: {} }))
    expect(menus[0].result.current.detection.detectionFailed).toBe(true)
    clearMenuWork()
    menus[0].rerender({ id: worktrees[count].id, open: true })
    await act(async () => {})
    expect(menus[0].result.current.detection.detectionFailed).toBe(false)
    expect(menuRenders.slice(1)).toEqual(Array(count - 1).fill(0))
    const currentWorktree = worktrees[count]
    const currentState = useAppStore.getState()
    expect(currentState.worktreesByRepo[currentWorktree.repoId]).toContain(currentWorktree)
    const selectedProject = projectIndex.getIndexedLocalRuntimeProject(
      currentState.projects,
      currentWorktree.projectId ?? currentWorktree.repoId,
      currentWorktree.repoId
    )
    if (!selectedProject) {
      throw new Error('Expected the current worktree project')
    }
    expect(selectedProject.sourceRepoIds).toEqual([currentWorktree.repoId])
    expect(
      currentState.projectHostSetups.filter((setup) => setup.repoId === currentWorktree.repoId)
    ).toEqual([expect.objectContaining({ projectId: selectedProject.id })])
    expect(
      catalog.projects.find((project) => project.sourceRepoIds?.includes(currentWorktree.repoId))
        ?.id
    ).toBe(selectedProject.id)
    expect(selectedProject.localWindowsRuntimePreference).toEqual({ kind: 'wsl', distro: 'Ubuntu' })
    expect(
      currentState.projects.filter((project) => project.id === selectedProject.id)
    ).toHaveLength(1)
    const unaffectedArrays = menus.slice(1).map((menu) => menu.result.current.detection.detectedIds)
    const legacyBeforeRuntime = currentState.detectedAgentIds
    clearMenuWork()
    await act(async () =>
      useAppStore.setState((state) => ({
        projects: projects(
          state.projects.map((project) =>
            project.id === selectedProject.id
              ? { ...project, localWindowsRuntimePreference: { kind: 'wsl', distro: 'Debian' } }
              : project
          )
        )
      }))
    )
    const currentRuntimeWork = {
      metric: 'active-menu-selected-runtime',
      consumers: count,
      projectFixtureCopies,
      projectRows,
      indexRows,
      resolverCalls: resolution.mock.calls.length,
      unaffectedRenders: menuRenders.slice(1)
    }
    expect(menuRenders[0]).toBeGreaterThan(0)
    expect(menuRenders.slice(1)).toEqual(Array(count - 1).fill(0))
    menus
      .slice(1)
      .forEach((menu, index) =>
        expect(menu.result.current.detection.detectedIds).toBe(unaffectedArrays[index])
      )
    expect(useAppStore.getState().detectedAgentIds).not.toBe(legacyBeforeRuntime)
    expect(useAppStore.getState().detectedAgentIds).toEqual(['codex'])
    expect(resolution.mock.calls.length).toBeGreaterThan(0)
    expect(
      resolution.mock.calls.every(([input]) => input.projectId === worktrees[count].repoId)
    ).toBe(true)
    expect(menus[0].result.current.detection.detectedIds).toEqual(['codex'])
    process.stdout.write(`${JSON.stringify(currentRuntimeWork)}\n`)
    expect(detectAgents).toHaveBeenLastCalledWith(
      expect.objectContaining({
        enabledOnly: true,
        wslDistro: 'Debian',
        projectRuntime: {
          status: 'resolved',
          runtime: {
            kind: 'wsl',
            distro: 'Debian',
            hostPlatform: 'wsl',
            projectId: currentWorktree.repoId,
            reason: 'project-override',
            cacheKey: `${currentWorktree.repoId}:wsl:Debian`
          }
        }
      })
    )
    expect(
      projectIndex.getIndexedLocalRuntimeProject(
        useAppStore.getState().projects,
        currentWorktree.projectId ?? currentWorktree.repoId,
        currentWorktree.repoId
      )?.localWindowsRuntimePreference
    ).toEqual({ kind: 'wsl', distro: 'Debian' })
    menus.forEach((menu) => menu.unmount())
    for (const spy of [imperative, projectRuntime, routes, rows, metadata, selections]) {
      spy.mockRestore()
    }
  }
  expect(measured[0]).toBeGreaterThanOrEqual(10)
  expect(measured[1]).toBeLessThanOrEqual(10 * measured[0])
  process.stdout.write(
    `${JSON.stringify({ metric: 'inventory-notification-reads', populations: [10, 100], projectCount: 1000, reads: measured, irrelevantContextResolutions: 0 })}\n`
  )
  resolution.mockRestore()
  selection.mockRestore()
  candidates.mockRestore()
  folderQualifications.mockRestore()
  folderAssociations.mockRestore()
  indexReads.mockRestore()
})

it('reads newly cached capabilities with the same AppState without acquiring an inventory', async () => {
  await exerciseCachedLocalAgentCapabilities(detectAgents, refreshAgents)
})

it('recovers mounted native consumers after availability changes alongside WSL launch and Settings inventories', async () => {
  await exerciseNativeAgentRecoveryAlongsideWslInventories(detectAgents)
})
