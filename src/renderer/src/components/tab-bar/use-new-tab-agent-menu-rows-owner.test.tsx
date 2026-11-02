// @vitest-environment happy-dom
import { EVERY_AGENT_CHAT } from '../../../../shared/native-chat/every-agent-chat.test-fixture'
import { act, cleanup, render, renderHook, screen } from '@testing-library/react'
import AgentCombobox from '@/components/agent/AgentCombobox'
import { TooltipProvider } from '@/components/ui/tooltip'
import { AGENT_CATALOG } from '@/lib/agent-catalog'
import { afterEach, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import type { AgentDetectionTarget } from '@/hooks/useDetectedAgents'
import { useAgentDetectionTargetForWorktree } from '@/hooks/useAgentDetectionTarget'
import { workspaceKindForWorktreeId } from '@/lib/agent-launch-route-input'
import {
  makeFolderWorkspace,
  makeWorktree,
  TEST_REPO
} from '@/store/slices/worktrees-slice-test-fixtures'
import { makeProjectGroup } from '@/components/sidebar/folder-workspace-composer-submit-fixtures'
import { setLocalRuntimeCapabilitiesForTests } from '@/runtime/local-runtime-capabilities'
import { resetRendererAppPlatformCacheForTests } from '@/lib/renderer-app-platform'
import type { Project } from '../../../../shared/project-types'
import { getDefaultSettings } from '../../../../shared/constants'
import type { AppState } from '@/store/types'
import type { Repo } from '../../../../shared/repo-types'
import type { SshConnectionState } from '../../../../shared/ssh-types'
import {
  STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY as CHAT,
  STRUCTURED_AGENT_SESSION_CLIENT_LAUNCH_MODE_CAPABILITY as CLIENT
} from '../../../../shared/agent-session/agent-session-runtime-capabilities'
import {
  useAgentMenuObservation,
  useNewTabAgentMenuRows,
  type AgentMenuRowsTarget
} from './use-new-tab-agent-menu-rows'
import { sourceControlRepoAgentRows } from '@/lib/source-control-agent-picker'
import { createAgentMenuTerminalPendingSelector } from './agent-menu-launch-facts'
import { makeDetectedResult } from '@/store/slices/worktrees-detected-listing-fixtures'
import { useMemo } from 'react'
import {
  connectedRuntimeStatus,
  publicRuntimeEnvironment
} from '@/runtime/paired-runtime-environment-test-fixture'
import { runtimeEnvironmentStatusFromSnapshot } from '../../../../shared/runtime-host-status'
import type { RuntimeStatus } from '../../../../shared/runtime-session-contracts'
const initial = useAppStore.getState()
afterEach(() => {
  cleanup()
  useAppStore.setState(initial, true)
  setLocalRuntimeCapabilitiesForTests(null)
  resetRendererAppPlatformCacheForTests()
})
it('settles ownerless continuation and plus inventory without borrowing agents, then recovers on hydration', async () => {
  const group = makeProjectGroup()
  const folder = makeFolderWorkspace({ id: 'f1', projectGroupId: group.id, folderPath: '/work' })
  const repo = { ...TEST_REPO, id: 'r1', path: '/work/local' }
  const cases: { worktreeId: string; rows: Partial<AppState> }[] = [
    {
      worktreeId: 'folder:f1',
      rows: {
        folderWorkspaces: [
          { ...folder, executionHostId: 'local' },
          { ...folder, executionHostId: 'ssh:other' }
        ]
      }
    },
    {
      worktreeId: 'folder:f1',
      rows: {
        folderWorkspaces: [folder],
        projectGroups: [group],
        repos: [repo, { ...repo, id: 'r2', path: '/work/remote', connectionId: 'other' }]
      }
    },
    { worktreeId: 'r1::/remote/restored', rows: { repos: [repo] } }
  ]
  for (const { worktreeId, rows } of cases) {
    const local = vi.fn<AppState['ensureDetectedAgents']>(async () => ['claude'])
    const otherHost = vi.fn(async () => [])
    const getStatus = vi.fn()
    Object.assign(window, { api: { runtime: { getStatus } } })
    setLocalRuntimeCapabilitiesForTests(worktreeId.startsWith('folder:') ? null : [CHAT, CLIENT])
    useAppStore.setState({
      ...initial,
      settings: { ...getDefaultSettings('/home/me'), nativeChatProviders: EVERY_AGENT_CHAT },
      activeWorktreeId: worktreeId,
      activeWorkspaceExecutionHostId: null,
      folderWorkspaces: [],
      projectGroups: [],
      repos: [],
      worktreesByRepo: {},
      detectedWorktreesByRepo: {},
      restoredRuntimeHostIdByWorkspaceSessionKey: {},
      detectedAgentIds: ['gemini'],
      remoteDetectedAgentIds: { other: ['codex'] },
      ensureDetectedAgents: local,
      ensureRemoteDetectedAgents: otherHost,
      ensureRuntimeDetectedAgents: otherHost,
      ...rows
    })
    const hook = renderHook(() => {
      const target = useAgentDetectionTargetForWorktree(worktreeId)
      const workspace = { kind: workspaceKindForWorktreeId(worktreeId), worktreeId }
      return {
        form: useAgentMenuObservation({ workspace }, true, target),
        plus: useNewTabAgentMenuRows(worktreeId, true, target)
      }
    })
    expect(hook.result.current.form.detection).toMatchObject({ detectedIds: [], isLoading: false })
    expect(hook.result.current.form.selectionFor('claude', 'terminal').ready).toBe(false)
    for (const model of [hook.result.current.form.model, hook.result.current.plus]) {
      expect(model.state).toBe('settled')
      expect(
        model.state === 'settled' &&
          model.rows.every(
            (row) =>
              row.kind === 'chat-unavailable' &&
              row.reason === 'check-failed' &&
              row.executionHostId === undefined
          )
      ).toBe(true)
    }
    for (const probe of [local, otherHost, getStatus]) {
      expect(probe).not.toHaveBeenCalled()
    }
    local.mockImplementation(async () => {
      useAppStore.setState({ detectedAgentIds: ['claude'] })
      return ['claude']
    })
    await act(async () => {
      setLocalRuntimeCapabilitiesForTests([CHAT, CLIENT])
      useAppStore.setState({
        folderWorkspaces: [{ ...folder, executionHostId: 'local' }],
        repos: [repo],
        worktreesByRepo: {
          r1: [makeWorktree({ id: worktreeId, repoId: 'r1', hostId: 'local', path: '/work/local' })]
        },
        detectedAgentIds: null
      })
    })
    expect(hook.result.current.form.detection.detectedIds).toEqual(['claude'])
    expect(hook.result.current.form.selectionFor('claude').ready).toBe(true)
    expect(
      hook.result.current.plus.state === 'settled' && hook.result.current.plus.rows
    ).toContainEqual({ kind: 'chat', agent: 'claude', executionHostId: 'local' })
    hook.unmount()
  }
})

const worktreeId = 'r1::/remote'
const sshState = {
  targetId: 'box',
  status: 'connecting' as const,
  error: null,
  reconnectAttempt: 0
}
const repo: Repo = { ...TEST_REPO, id: 'r1', connectionId: 'box', executionHostId: 'ssh:box' }

/** An SSH workspace whose host has not reported its OS, with Codex's CLI already detected. */
function seedSshWorkspace(): void {
  setLocalRuntimeCapabilitiesForTests([])
  useAppStore.setState({
    ...initial,
    settings: { ...getDefaultSettings('/home/me'), agentDefaultSurface: 'terminal' },
    activeWorktreeId: worktreeId,
    repos: [repo],
    worktreesByRepo: {
      r1: [makeWorktree({ id: worktreeId, repoId: 'r1', hostId: 'ssh:box', path: '/remote' })]
    },
    remoteDetectedAgentIds: { box: ['codex'] },
    sshConnectionStates: new Map([['box', sshState]]),
    ensureRemoteDetectedAgents: vi.fn<AppState['ensureRemoteDetectedAgents']>(async () => ['codex'])
  })
}

it('holds only terminal choices while SSH connects, for a workspace and a repo target, then settles', async () => {
  seedSshWorkspace()
  const hook = renderHook(() => {
    const target = useAgentDetectionTargetForWorktree(worktreeId)
    // Source Control's launch into a workspace the repo does not have yet.
    const prospective = sourceControlRepoAgentRows(repo)
    return {
      workspace: useAgentMenuObservation(worktreeId, true, target),
      repo: useAgentMenuObservation(prospective.target, true, prospective.detectionTarget)
    }
  })
  const pendingKey = hook.result.current.workspace.contextKey
  for (const observation of [hook.result.current.workspace, hook.result.current.repo]) {
    expect(observation.model).toMatchObject({ state: 'settled', terminalPending: true })
    expect(observation.selectionFor('codex', 'terminal').ready).toBe(false)
  }
  await act(async () => {
    useAppStore.setState({
      sshConnectionStates: new Map([['box', { ...sshState, status: 'connected' }]])
    })
  })
  // Readiness is not identity: the picker's owner and acquisition keep their key.
  expect(hook.result.current.workspace.contextKey).toBe(pendingKey)
  for (const observation of [hook.result.current.workspace, hook.result.current.repo]) {
    expect(observation.model).toMatchObject({ state: 'settled', terminalPending: false })
    // A settled missing fact is owned by the launcher; it must not leave a permanent wait.
    expect(observation.selectionFor('codex', 'terminal').ready).toBe(true)
  }
  await act(async () => {
    useAppStore.setState({
      sshConnectionStates: new Map([
        ['box', { ...sshState, status: 'connected', remotePlatform: 'linux' }]
      ])
    })
  })
  expect(hook.result.current.workspace.model).toMatchObject({
    state: 'settled',
    terminalPending: false,
    rows: expect.arrayContaining([
      expect.objectContaining({ agent: 'codex', executionHostId: 'ssh:box' })
    ])
  })
  expect(hook.result.current.workspace.selectionFor('codex', 'terminal').ready).toBe(true)
})

it('lets the picker open to choose chat while only the chosen terminal waits for SSH', () => {
  seedSshWorkspace()
  let ready: boolean | undefined
  function Picker() {
    const observation = useAgentMenuObservation(
      worktreeId,
      true,
      useAgentDetectionTargetForWorktree(worktreeId)
    )
    const selection = observation.selectionFor('codex', 'terminal')
    ready = selection.ready
    return (
      <AgentCombobox
        agents={AGENT_CATALOG}
        value="codex"
        onValueChange={vi.fn()}
        surfaceRows={{ model: observation.model, selection, surface: 'terminal', onPick: vi.fn() }}
      />
    )
  }
  render(<Picker />, { wrapper: TooltipProvider })
  // Starting the terminal waits; choosing another surface in the picker does not.
  expect(ready).toBe(false)
  expect(screen.getByRole('combobox').hasAttribute('disabled')).toBe(false)
})

it.each([1, 10])(
  'unrelated store writes visit no repos and re-render no picker (x%i contexts and repos)',
  async (scale) => {
    seedSshWorkspace()
    useAppStore.setState({
      sshConnectionStates: new Map([['box', { ...sshState, status: 'connected' as const }]])
    })
    let visits = 0
    const repos = Array.from({ length: 20 * scale }, (_, index) => {
      const id = `r${index}`
      const row = { ...repo, path: `/${id}` }
      return Object.defineProperty(row, 'id', {
        enumerable: true,
        get: () => {
          visits += 1
          return id
        }
      })
    })
    useAppStore.setState({ repos })
    let renders = 0
    const hooks = Array.from({ length: 2 * scale }, (_, index) =>
      renderHook(() => {
        renders += 1
        return useAgentMenuObservation(
          sourceControlRepoAgentRows(repos[index] ?? null).target,
          false,
          { kind: 'ssh', connectionId: 'box' }
        )
      })
    )
    await act(async () => {})
    const settledRenders = renders
    visits = 0
    for (const update of [
      () => useAppStore.setState({ ptyIdsByTabId: { unrelated: ['pty'] } }),
      () => useAppStore.setState({ rightSidebarWidth: 412 })
    ]) {
      await act(async () => update())
    }
    expect(visits).toBe(0)
    expect(renders).toBe(settledRenders)
    await act(async () =>
      useAppStore.setState({ sshConnectionStates: new Map([['box', sshState]]) })
    )
    expect(hooks[0]?.result.current.model).toMatchObject({ terminalPending: true })
    for (const hook of hooks) {
      hook.unmount()
    }
  }
)

/** Copies whose `id` reads are counted: every index build and owner scan reads it. */
function countIdReads<T extends { id: string }>(rows: T[], onRead: () => void): T[] {
  return rows.map((row) => {
    const { id } = row
    return Object.defineProperty({ ...row }, 'id', {
      enumerable: true,
      get: () => {
        onRead()
        return id
      }
    })
  })
}

/** Closed pickers, each counting its own renders once mount effects settle. */
async function mountPickers(
  targets: { target: string | AgentMenuRowsTarget; detection: AgentDetectionTarget }[]
) {
  const renders = targets.map(() => 0)
  const hooks = targets.map(({ target, detection }, index) =>
    renderHook(() => {
      renders[index] += 1
      return useAgentMenuObservation(target, false, detection)
    })
  )
  await act(async () => {})
  return {
    renders,
    pending: () =>
      hooks.map(({ result: { current } }) =>
        current.model.state === 'settled' ? current.model.terminalPending : 'loading'
      ),
    unmount: () => hooks.forEach((hook) => hook.unmount())
  }
}

const connecting = (targetId: string) => ({ ...sshState, targetId })
const linux = (targetId: string) => ({
  ...connecting(targetId),
  status: 'connected' as const,
  remotePlatform: 'linux' as const
})
const direct = (box: SshConnectionState, other: SshConnectionState) =>
  new Map([
    ['box', box],
    ['other', other]
  ])
// A paired server's own connection to `box`, as it publishes it.
const viaServer = (box: SshConnectionState) =>
  new Map([
    [
      'srv',
      {
        connectionStates: new Map([['box', box]]),
        targetLabels: new Map(),
        targetGenerations: new Map(),
        removedTargetLabels: new Map(),
        targetsHydrated: true
      }
    ]
  ])

it.each([1, 10])(
  "isolates each SSH host's pickers, direct and nested, and indexes a republication once (x%i)",
  async (scale) => {
    setLocalRuntimeCapabilitiesForTests([])
    let visits = 0
    const countVisit = () => {
      visits += 1
    }
    const groups = [
      { repoId: 'rb', hostId: 'ssh:box', detection: { kind: 'ssh', connectionId: 'box' } },
      { repoId: 'ro', hostId: 'ssh:other', detection: { kind: 'ssh', connectionId: 'other' } },
      { repoId: 'rn', hostId: 'ssh:box', detection: { kind: 'runtime', environmentId: 'srv' } }
    ] satisfies { repoId: string; hostId: `ssh:${string}`; detection: AgentDetectionTarget }[]
    const filler: Repo = { ...TEST_REPO, connectionId: 'third', executionHostId: 'ssh:third' }
    const repos = countIdReads(
      [
        ...groups.map(({ repoId, hostId }) => ({
          ...TEST_REPO,
          id: repoId,
          executionHostId: hostId,
          connectionId: hostId.slice('ssh:'.length)
        })),
        ...Array.from({ length: 20 * scale }, (_, index) => ({ ...filler, id: `f${index}` }))
      ],
      countVisit
    )
    const ids = groups.map(({ repoId }) =>
      Array.from({ length: scale }, (_, index) => `${repoId}::/${repoId}/${index}`)
    )
    useAppStore.setState({
      ...initial,
      settings: { ...getDefaultSettings('/home/me'), agentDefaultSurface: 'terminal' },
      repos,
      worktreesByRepo: Object.fromEntries(
        groups.map(({ repoId, hostId }, group) => [
          repoId,
          ids[group].map((id) =>
            makeWorktree({
              id,
              repoId,
              hostId,
              ...(repoId === 'rn' ? { runtimeOwnerEnvironmentId: 'srv' } : {})
            })
          )
        ])
      ),
      remoteDetectedAgentIds: { box: ['codex'], other: ['codex'] },
      runtimeDetectedAgentIds: { srv: ['codex'] },
      sshConnectionStates: direct(connecting('box'), connecting('other')),
      sshStateByEnvironment: viaServer(connecting('box'))
    })
    const visitsFor = async (update: () => void) => {
      visits = 0
      await act(async () => update())
      return visits
    }
    const republish = (id: string) => () =>
      useAppStore.setState((state) => ({
        repos: [...state.repos, ...countIdReads([{ ...filler, id }], countVisit)]
      }))
    // Store subscribers outside the picker read repos on these writes; measure them unmounted.
    const storeOnly = {
      republish: await visitsFor(republish('late0')),
      connection: await visitsFor(() =>
        useAppStore.setState({
          sshConnectionStates: direct(connecting('box'), connecting('other'))
        })
      )
    }
    const pickers = await mountPickers(
      groups.flatMap(({ detection }, group) => ids[group].map((id) => ({ target: id, detection })))
    )
    const perGroup = <T,>(values: T[]) =>
      groups.map((_, group) => [...new Set(values.slice(group * scale, (group + 1) * scale))])
    expect(perGroup(pickers.pending())).toEqual([[true], [true], [true]])
    const transitions: [() => void, number, boolean[]][] = [
      [() => useAppStore.setState({ rightSidebarWidth: 412 }), 0, [true, true, true]],
      [
        () =>
          useAppStore.setState({ sshConnectionStates: direct(linux('box'), connecting('other')) }),
        storeOnly.connection,
        [false, true, true]
      ],
      [
        () => useAppStore.setState({ sshConnectionStates: direct(linux('box'), linux('other')) }),
        storeOnly.connection,
        [false, false, true]
      ],
      [
        () => useAppStore.setState({ sshStateByEnvironment: viaServer(linux('box')) }),
        storeOnly.connection,
        [false, false, false]
      ]
    ]
    let seen = [...pickers.renders]
    let previous = [true, true, true]
    for (const [update, storeVisits, pending] of transitions) {
      // Connection facts are read live: no picker re-resolves an owner for them.
      expect(await visitsFor(update)).toBe(storeVisits)
      expect(perGroup(pickers.pending())).toEqual(pending.map((value) => [value]))
      // Only the pickers whose host changed render.
      expect(perGroup(pickers.renders.map((count, index) => count > seen[index]))).toEqual(
        pending.map((value, group) => [value !== previous[group]])
      )
      seen = [...pickers.renders]
      previous = pending
    }
    // Another host's project arriving builds the shared id index once, not once per picker.
    const pickerVisits = (await visitsFor(republish('late1'))) - storeOnly.republish
    // Each shared index is built once per published array (about four today), whatever the picker count.
    expect(pickerVisits).toBeLessThanOrEqual(5 * repos.length)
    expect(pickers.renders).toEqual(seen)
    pickers.unmount()
  }
)

it.each([1, 10])(
  'Windows local pickers read no projects on unrelated writes (x%i)',
  async (scale) => {
    Object.assign(window, { api: { platform: { get: () => ({ platform: 'win32' }) } } })
    resetRendererAppPlatformCacheForTests()
    setLocalRuntimeCapabilitiesForTests([])
    let visits = 0
    const repoIds = Array.from({ length: 2 * scale }, (_, index) => `l${index}`)
    const projects: Project[] = countIdReads(
      Array.from({ length: 20 * scale }, (_, index) => ({
        id: `p${index}`,
        displayName: '',
        badgeColor: '',
        sourceRepoIds: [],
        createdAt: 0,
        updatedAt: 0
      })),
      () => {
        visits += 1
      }
    )
    useAppStore.setState({
      ...initial,
      settings: { ...getDefaultSettings('C:\\Users\\me'), agentDefaultSurface: 'terminal' },
      repos: repoIds.map((id) => ({ ...TEST_REPO, id, path: `C:\\${id}` })),
      worktreesByRepo: Object.fromEntries(
        repoIds.map((id) => [
          id,
          [makeWorktree({ id: `${id}::C:\\${id}`, repoId: id, hostId: 'local', path: `C:\\${id}` })]
        ])
      ),
      projects,
      detectedAgentIds: ['codex']
    })
    const pickers = await mountPickers(
      repoIds.map((id) => ({ target: `${id}::C:\\${id}`, detection: { kind: 'local' } }))
    )
    // Rendering resolves each workspace's Windows runtime from its project.
    expect(visits).toBeGreaterThan(0)
    const settled = [...pickers.renders]
    visits = 0
    for (const update of [
      () => useAppStore.setState({ rightSidebarWidth: 412 }),
      () => useAppStore.setState({ sshConnectionStates: new Map([['box', sshState]]) })
    ]) {
      await act(async () => update())
    }
    expect(visits).toBe(0)
    expect(pickers.renders).toEqual(settled)
    expect(pickers.pending()).toEqual(repoIds.map(() => false))
    pickers.unmount()
  }
)

it.each([1, 10])(
  'resolves distinct repo targets from one shared index, cold and after another host republishes (x%i)',
  async (scale) => {
    setLocalRuntimeCapabilitiesForTests([])
    let visits = 0
    const countVisit = () => {
      visits += 1
    }
    const box: Repo = { ...TEST_REPO, connectionId: 'box', executionHostId: 'ssh:box' }
    const third: Repo = { ...TEST_REPO, connectionId: 'third', executionHostId: 'ssh:third' }
    const targets = Array.from({ length: 2 * scale }, (_, index) => `t${index}`)
    const repos = countIdReads(
      [
        ...targets.map((id) => ({ ...box, id })),
        ...Array.from({ length: 18 * scale }, (_, index) => ({ ...third, id: `f${index}` }))
      ],
      countVisit
    )
    useAppStore.setState({
      ...initial,
      settings: { ...getDefaultSettings('/home/me'), agentDefaultSurface: 'terminal' },
      remoteDetectedAgentIds: { box: ['codex'] },
      sshConnectionStates: direct(connecting('box'), connecting('other'))
    })
    const visitsFor = async (update: () => void) => {
      visits = 0
      await act(async () => update())
      return visits
    }
    // Replaces another host's row, as a fresh repos snapshot does.
    const republish = (id: string) => () =>
      useAppStore.setState((state) => ({
        repos: state.repos.map((row, index) =>
          index === state.repos.length - 1 ? countIdReads([{ ...third, id }], countVisit)[0] : row
        )
      }))
    // Store subscribers outside the picker read repos on publication; measure them unmounted.
    const storeOnly = {
      cold: await visitsFor(() => useAppStore.setState({ repos })),
      republish: await visitsFor(republish('late0'))
    }
    // Workspaces not created yet: each picker launches on its repo's host.
    const prospective = (repoId: string) => ({
      target: { workspace: { kind: 'git-worktree' as const, repoId, executionHostId: 'ssh:box' } },
      detection: { kind: 'ssh' as const, connectionId: 'box' }
    })
    visits = 0
    const pickers = await mountPickers([
      ...targets.map(prospective),
      // The repeated-target control: many pickers on one repo add no index work of their own.
      ...targets.map(() => prospective('t0'))
    ])
    const cold = visits
    expect(pickers.pending()).toEqual(Array(2 * targets.length).fill(true))
    const settled = [...pickers.renders]
    const pickerVisits = (await visitsFor(republish('late1'))) - storeOnly.republish
    // One shared index per snapshot (about 1.2 reads per repo today), not a catalog scan per
    // distinct target: 20 targets x 200 repos would be 4,000 at x10.
    expect(cold).toBeLessThanOrEqual(2 * repos.length)
    expect(pickerVisits).toBeLessThanOrEqual(2 * repos.length)
    expect(pickers.renders).toEqual(settled)
    pickers.unmount()
  }
)

it("re-derives a cached host when the workspace's owner moves in a new snapshot", async () => {
  setLocalRuntimeCapabilitiesForTests([])
  const local: Repo = { ...TEST_REPO, id: 'r1', path: '/work' }
  const owned = (hostId: 'local' | 'ssh:box') => ({
    repos: [
      hostId === 'local' ? local : { ...local, connectionId: 'box', executionHostId: hostId }
    ],
    worktreesByRepo: {
      r1: [makeWorktree({ id: 'r1::/work', repoId: 'r1', hostId, path: '/work' })]
    }
  })
  useAppStore.setState({
    ...initial,
    settings: { ...getDefaultSettings('/home/me'), agentDefaultSurface: 'terminal' },
    ...owned('local'),
    detectedAgentIds: ['codex'],
    remoteDetectedAgentIds: { box: ['codex'] },
    sshConnectionStates: direct(connecting('box'), connecting('other'))
  })
  const pending = createAgentMenuTerminalPendingSelector({ worktreeId: 'r1::/work' })
  expect(pending(useAppStore.getState())).toBe(false)
  // The move arrives as one publication while `box` is still connecting.
  useAppStore.setState(owned('ssh:box'))
  expect(pending(useAppStore.getState())).toBe(true)
  useAppStore.setState({ sshConnectionStates: direct(linux('box'), connecting('other')) })
  expect(pending(useAppStore.getState())).toBe(false)
  useAppStore.setState({ sshConnectionStates: direct(connecting('box'), connecting('other')) })
  expect(pending(useAppStore.getState())).toBe(true)
  useAppStore.setState(owned('local'))
  expect(pending(useAppStore.getState())).toBe(false)
})

it('waits on a paired server only while contact is checking without a reported OS', () => {
  const worktree = makeWorktree({
    id: 'r1::/srv',
    repoId: 'r1',
    hostId: 'runtime:srv',
    runtimeOwnerEnvironmentId: 'srv'
  })
  const answered = connectedRuntimeStatus('srv-runtime', 1).status
  // The host status snapshot the client publishes as it reaches the server.
  const contact = (verification: 'checking' | 'verified', status: RuntimeStatus | null) => ({
    runtimeStatusByEnvironmentId: new Map([
      [
        'srv',
        runtimeEnvironmentStatusFromSnapshot({
          environmentId: 'srv',
          pairingRevision: 1,
          sequence: 1,
          checkedAt: 1,
          status,
          verification,
          transport: verification === 'verified' ? 'ready' : 'connecting'
        })
      ]
    ])
  })
  useAppStore.setState({
    ...initial,
    repos: [{ ...TEST_REPO, id: 'r1', executionHostId: 'runtime:srv' }],
    worktreesByRepo: { r1: [worktree] },
    ...contact('checking', null)
  })
  const pending = createAgentMenuTerminalPendingSelector({ worktreeId: worktree.id })
  expect(pending(useAppStore.getState())).toBe(true)
  useAppStore.setState(contact('verified', answered && { ...answered, hostPlatform: 'linux' }))
  expect(pending(useAppStore.getState())).toBe(false)
})

/** Copies whose owner-field reads (`id`, `executionHostId`) are counted. */
function countOwnerReads<T extends { id: string; executionHostId?: Repo['executionHostId'] }>(
  rows: T[],
  onRead: () => void
): T[] {
  return countIdReads(rows, onRead).map((row) => {
    const { executionHostId } = row
    return Object.defineProperty(row, 'executionHostId', {
      enumerable: true,
      get: () => {
        onRead()
        return executionHostId
      }
    })
  })
}

it.each([1, 10])(
  "keeps a detected twin's readiness on its owner across settings, focus and catalog writes (x%i)",
  async (scale) => {
    let visits = 0
    const countVisit = () => {
      visits += 1
    }
    const project: Repo = { ...TEST_REPO, id: 'repo-1', path: '/srv/worktree' }
    const filler: Repo = { ...TEST_REPO, connectionId: 'third', executionHostId: 'ssh:third' }
    // The same project listed here and by a paired server; its rows below carry no owner stamp.
    const repos = countOwnerReads(
      [
        { ...project, executionHostId: 'local' },
        { ...project, executionHostId: 'runtime:hub-a' },
        ...Array.from({ length: 20 * scale }, (_, index) => ({ ...filler, id: `f${index}` }))
      ],
      countVisit
    )
    const ids = Array.from({ length: 2 * scale }, (_, index) => `repo-1::/srv/worktree/${index}`)
    const detected = (stampFirst: boolean) => ({
      'repo-1': makeDetectedResult(
        'repo-1',
        ids.map((id, index) =>
          makeWorktree({
            id,
            repoId: 'repo-1',
            path: id.split('::')[1],
            ...(stampFirst && index === 0 ? { runtimeOwnerEnvironmentId: 'hub-a' } : {})
          })
        )
      )
    })
    const hubA = (verification: 'checking' | 'verified') => ({
      runtimeStatusByEnvironmentId: new Map([
        [
          'hub-a',
          runtimeEnvironmentStatusFromSnapshot({
            environmentId: 'hub-a',
            pairingRevision: 1,
            sequence: 1,
            checkedAt: 1,
            status:
              verification === 'verified'
                ? { ...connectedRuntimeStatus('hub-runtime', 1).status!, hostPlatform: 'linux' }
                : null,
            verification,
            transport: verification === 'verified' ? 'ready' : 'connecting'
          })
        ]
      ])
    })
    useAppStore.setState({
      ...initial,
      settings: getDefaultSettings('/home/me'),
      repos,
      detectedWorktreesByRepo: detected(false),
      runtimeEnvironments: [publicRuntimeEnvironment({ id: 'hub-a' })],
      runtimeEnvironmentCatalogHydrated: true,
      ...hubA('checking')
    })
    const visitsFor = async (update: () => void) => {
      visits = 0
      await act(async () => update())
      return visits
    }
    const settingsWrite = () =>
      useAppStore.setState((state) => ({
        settings: { ...state.settings!, terminalFontSize: state.settings!.terminalFontSize + 1 }
      }))
    const focusWrite = (environmentId: string | null) => () =>
      useAppStore.setState((state) => ({
        settings: { ...state.settings!, activeRuntimeEnvironmentId: environmentId }
      }))
    const republish = (id: string) => () =>
      useAppStore.setState((state) => ({
        repos: state.repos.map((row, index) =>
          index === state.repos.length - 1
            ? countOwnerReads([{ ...filler, id }], countVisit)[0]
            : row
        )
      }))
    // Store subscribers outside readiness, measured with nothing mounted.
    const storeOnly = {
      settings: await visitsFor(settingsWrite),
      focus: await visitsFor(focusWrite('hub-a')),
      republish: await visitsFor(republish('late0'))
    }
    // The readiness subscription alone, for distinct targets and a repeated one.
    const targets = [...ids, ...ids.map(() => ids[0])]
    const renders = targets.map(() => 0)
    const hooks = targets.map((worktreeId, index) =>
      renderHook(() => {
        renders[index] += 1
        const selector = useMemo(() => createAgentMenuTerminalPendingSelector({ worktreeId }), [])
        return useAppStore(selector)
      })
    )
    await act(async () => {})
    const pending = () => hooks.map((hook) => hook.result.current)
    expect(pending()).toEqual(targets.map(() => false))
    const settled = [...renders]
    // Neither an unrelated setting nor the focused server is an owner of an existing workspace.
    expect(await visitsFor(settingsWrite)).toBe(storeOnly.settings)
    expect(await visitsFor(focusWrite(null))).toBe(storeOnly.focus)
    expect(renders).toEqual(settled)
    expect(pending()).toEqual(targets.map(() => false))
    // Which consumers rendered during one settled update, against a fresh baseline.
    const renderedDuring = async (update: () => Promise<unknown>) => {
      const before = [...renders]
      await update()
      return renders.map((count, index) => count > before[index])
    }
    const none = targets.map(() => false)
    const firstWorkspace = targets.map((id) => id === ids[0])
    // Another host's row changing re-resolves each target over its own id's rows only.
    let readinessVisits = 0
    expect(
      await renderedDuring(async () => {
        readinessVisits = (await visitsFor(republish('late1'))) - storeOnly.republish
      })
    ).toEqual(none)
    expect(readinessVisits).toBeLessThanOrEqual(3 * repos.length + 4 * targets.length)
    expect(pending()).toEqual(none)
    // Stamping one row with a server still checking, with no OS, waits only that row's pickers.
    expect(
      await renderedDuring(() =>
        act(async () => useAppStore.setState({ detectedWorktreesByRepo: detected(true) }))
      )
    ).toEqual(firstWorkspace)
    expect(pending()).toEqual(firstWorkspace)
    expect(
      await renderedDuring(() => act(async () => useAppStore.setState(hubA('verified'))))
    ).toEqual(firstWorkspace)
    expect(pending()).toEqual(none)
    hooks.forEach((hook) => hook.unmount())
  }
)
