// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import type { TuiAgent } from '../../../../shared/tui-agent'
import { useAgentDetectionTargetForWorktree } from '@/hooks/useAgentDetectionTarget'
import { getDefaultSettings } from '../../../../shared/constants'
import {
  makeFolderWorkspace,
  makeWorktree,
  TEST_REPO
} from '@/store/slices/worktrees-slice-test-fixtures'
import type * as RouteInput from '@/lib/agent-launch-route-input'
import type * as ChatProgram from '@/lib/host-chat-program'
import type * as MenuRows from '@/lib/new-tab-agent-menu-rows'
import type * as ZustandShallow from 'zustand/react/shallow'
import type * as HostAgentSettingsTransport from '@/components/settings/agent-launch-settings-transport'
import type { RuntimeEnvironmentStatus } from '../../../../shared/runtime-host-status'
import { useTabBarCreateMenuController } from './use-tab-bar-create-menu-controller'
import {
  buildTabAgentLaunchOptionsFromRows,
  findMatchingTabAgentLaunchOptions
} from './tab-agent-launch-options'
import {
  readLocalRuntimeCapabilitiesOrUnknown,
  setLocalRuntimeCapabilitiesForTests
} from '@/runtime/local-runtime-capabilities'
import {
  STRUCTURED_AGENT_SESSION_AVAILABILITY_RUNTIME_CAPABILITY as AVAILABILITY,
  STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY as CHAT,
  STRUCTURED_AGENT_SESSION_CLIENT_LAUNCH_MODE_CAPABILITY as CLIENT,
  STRUCTURED_AGENT_SESSION_REGISTERED_AGENTS_RUNTIME_CAPABILITY as CATALOG
} from '../../../../shared/protocol-version'
const mocks = vi.hoisted(() => ({
  support: vi.fn(),
  subscribe: vi.fn(),
  publishing: false,
  catalog: vi.fn(),
  failed: vi.fn(),
  load: vi.fn(),
  detection: vi.fn(),
  realRoutes: false,
  routes: Array<RouteInput.AgentLaunchRouteArgs>(),
  answers: Array<Parameters<typeof MenuRows.hostChatAnswer>[0]>(),
  selectors: 0,
  records: 0,
  lists: 0,
  metadata: 0,
  countedLists: new WeakSet<object>(),
  program:
    vi.fn<
      (
        ...args: Parameters<typeof ChatProgram.readChatProgram>
      ) => ChatProgram.ChatProgramObservation | undefined
    >()
}))
vi.mock('zustand/react/shallow', async (importOriginal) => {
  const actual = await importOriginal<typeof ZustandShallow>()
  return {
    useShallow: <S, U>(selector: (state: S) => U) =>
      actual.useShallow((state: S) => {
        mocks.selectors++
        return selector(state)
      })
  }
})
vi.mock('@/lib/new-tab-agent-menu-rows', async (importOriginal) => {
  const actual = await importOriginal<typeof MenuRows>()
  return {
    ...actual,
    buildNewTabAgentMenuRows: (...args: Parameters<typeof actual.buildNewTabAgentMenuRows>) => {
      const rows = actual.buildNewTabAgentMenuRows(...args)
      mocks.metadata += rows.length
      return rows
    },
    hostChatAnswer: (input: Parameters<typeof actual.hostChatAnswer>[0]) => {
      mocks.answers.push(input)
      if (mocks.realRoutes) {
        if (input.hostCapabilities) {
          counted(input.hostCapabilities)
        }
        if (input.hostStructuredAgents) {
          counted(input.hostStructuredAgents)
        }
      }
      return actual.hostChatAnswer(input)
    }
  }
})
vi.mock('@/components/settings/agent-launch-settings-transport', async (importOriginal) => {
  const actual = await importOriginal<typeof HostAgentSettingsTransport>()
  return { ...actual, readHostAgentLaunchSettings: vi.fn().mockResolvedValue(null) }
})
vi.mock('@/runtime/runtime-rpc-subscribe', () => ({ subscribeRuntimeRpc: mocks.subscribe }))
vi.mock('@/lib/structured-agent-session-host-admission', () => ({
  askHostCreateSupport: mocks.support
}))
// Like the real hook: a closed menu acquires nothing, and the stored inventory stays.
vi.mock('@/hooks/useDetectedAgents', () => ({
  useDetectedAgents: mocks.detection
}))
vi.mock('@/runtime/host-structured-agents', () => ({
  readHostStructuredAgents: mocks.catalog,
  readHostStructuredAgentsForRuntime: mocks.catalog,
  hostStructuredAgentsReadFailed: mocks.failed,
  loadHostStructuredAgents: mocks.load,
  relearnHostStructuredAgents: mocks.load,
  hostStructuredAgentsVersion: () => 0,
  subscribeHostStructuredAgents: () => () => {}
}))
vi.mock('@/lib/agent-launch-route-input', async (importOriginal) => {
  const actual = await importOriginal<typeof RouteInput>()
  return {
    ...actual,
    resolveAgentLaunchHost: (...args: Parameters<typeof actual.resolveAgentLaunchHost>) =>
      mocks.realRoutes
        ? actual.resolveAgentLaunchHost(...args)
        : {
            executionHostId: 'local',
            hostCapabilities:
              readLocalRuntimeCapabilitiesOrUnknown() === null
                ? null
                : [CHAT, CLIENT, CATALOG, ...(mocks.publishing ? [AVAILABILITY] : [])]
          },
    buildAgentLaunchRouteInput: (...args: Parameters<typeof actual.buildAgentLaunchRouteInput>) => {
      const [state, { agent }] = args
      if (mocks.realRoutes) {
        mocks.routes.push(args[1])
        return actual.buildAgentLaunchRouteInput(state, args[1])
      }
      return {
        agent,
        executionHostId: 'local',
        hostCapabilities:
          readLocalRuntimeCapabilitiesOrUnknown() === null
            ? null
            : [CHAT, CLIENT, CATALOG, ...(mocks.publishing ? [AVAILABILITY] : [])],
        clientCapabilities: [CHAT, CLIENT],
        hostStructuredAgents: ['claude', 'codex', 'opencode']
      }
    }
  }
})
vi.mock('@/lib/host-chat-program', async (importOriginal) => {
  const actual = await importOriginal<typeof ChatProgram>()
  return {
    ...actual,
    readChatProgram: (...args: Parameters<typeof actual.readChatProgram>) =>
      mocks.program(...args) ?? actual.readChatProgram(...args)
  }
})
import {
  useAgentMenuObservation,
  useNewTabAgentMenuRows,
  type AgentMenuRowsTarget,
  type NewTabAgentMenuModel
} from './use-new-tab-agent-menu-rows'
const actualRouteInput = await vi.importActual<typeof RouteInput>('@/lib/agent-launch-route-input')
const initial = useAppStore.getState()
beforeEach(() => {
  mocks.support.mockReset()
  mocks.subscribe.mockReset().mockResolvedValue({ unsubscribe: () => {} })
  mocks.publishing = false
  mocks.realRoutes = false
  mocks.program.mockReset()
  mocks.catalog
    .mockReset()
    .mockReturnValue(['claude', 'codex', 'opencode'].map((agent) => ({ agent, capabilities: {} })))
  mocks.failed.mockReset().mockReturnValue(false)
  mocks.load.mockReset().mockResolvedValue(undefined)
  mocks.detection
    .mockReset()
    .mockReturnValue({ detectedIds: ['claude', 'codex', 'opencode', 'gemini'] })
  setLocalRuntimeCapabilitiesForTests([CHAT, CLIENT, CATALOG])
  useAppStore.setState({
    ...initial,
    activeWorktreeId: 'one',
    settings: {
      ...getDefaultSettings('/home/me'),
      experimentalNativeChat: true,
      disabledTuiAgents: []
    },
    localDetectedAgentIdsByContext: { host: ['claude', 'codex'] },
    detectedAgentIds: ['claude', 'codex', 'opencode']
  })
})
afterEach(cleanup)

function counted<T extends readonly unknown[]>(values: T): T {
  if (mocks.countedLists.has(values)) {
    return values
  }
  mocks.countedLists.add(values)
  values.forEach((value, index) =>
    Object.defineProperty(values, index, {
      get: () => {
        mocks.lists++
        return value
      }
    })
  )
  return values
}
function resetWork(): void {
  mocks.routes.length =
    mocks.answers.length =
    mocks.selectors =
    mocks.records =
    mocks.lists =
    mocks.metadata =
      0
  mocks.program.mockClear()
  mocks.catalog.mockClear()
}
function work() {
  return {
    routes: mocks.routes.length,
    selectors: mocks.selectors,
    records: mocks.records,
    answers: mocks.answers.length,
    programs: mocks.program.mock.calls.length,
    lists: mocks.lists,
    catalogs: mocks.catalog.mock.calls.length,
    metadata: mocks.metadata
  }
}

type OwnerProps = { target: string | AgentMenuRowsTarget; phase: string }
type OwnerResult = {
  model: NewTabAgentMenuModel
  selectionFor?: ReturnType<typeof useAgentMenuObservation>['selectionFor']
  controller?: ReturnType<typeof useTabBarCreateMenuController>
}
function useMenuOwner({ target }: OwnerProps): OwnerResult {
  return { model: useNewTabAgentMenuRows(target, true, { kind: 'local' }) }
}
function usePickerOwner({ target }: OwnerProps): OwnerResult {
  return useAgentMenuObservation(target, true, { kind: 'local' })
}
function useTabOwner({ target, phase }: OwnerProps): OwnerResult {
  const controller = useTabBarCreateMenuController({
    worktreeId: typeof target === 'string' ? target : (target.workspace.worktreeId ?? ''),
    resolvedGroupId: 'group',
    terminalOnly: false,
    showAgentLaunchItems: phase !== 'hidden',
    mobileEmulatorEnabled: false,
    managedBrowserCreationEnabled: false,
    mobileEmulatorCreationEnabled: false,
    workspaceHasSimulatorTab: false,
    showWindowsShellMenu: false,
    projectRuntimeShellMenuMode: null,
    defaultWindowsShell: 'powershell',
    defaultWindowsPowerShellImplementation: 'auto',
    agentDetectionTarget: { kind: 'local' },
    windowsTerminalCapabilities: {
      wslAvailable: false,
      wslDistros: [],
      pwshAvailable: false,
      gitBashAvailable: false,
      hostPlatform: null,
      isLoading: false
    },
    onNewTerminalTab: () => {},
    onNewBrowserTab: () => {}
  })
  return { model: controller.agentMenu, controller }
}

it('shares real answer preparation at N and 10N across candidates, owners and selections', async () => {
  mocks.realRoutes = true
  const candidates = ['opencode', 'pi', 'omp'] as const
  mocks.catalog.mockReturnValue(
    counted(['claude', 'codex', ...candidates].map((agent) => ({ agent, capabilities: {} })))
  )
  const previous = new Map<string, ReturnType<typeof work>>()
  for (const count of [100, 1000]) {
    const worktreeId = `${TEST_REPO.id}::/work/${count - 1}`
    const worktrees = Array.from({ length: count }, (_, index) => {
      const id = `${TEST_REPO.id}::/work/${index}`
      return Object.defineProperty(
        makeWorktree({ id, path: `/work/${index}`, repoId: TEST_REPO.id, hostId: 'local' }),
        'id',
        {
          get: () => {
            mocks.records++
            return id
          },
          enumerable: true
        }
      )
    })
    for (const useOwner of [useMenuOwner, usePickerOwner, useTabOwner]) {
      for (const launchCwd of useOwner === useTabOwner ? [undefined] : [undefined, '.']) {
        const zero = new Map<string, ReturnType<typeof work>>()
        for (const viable of [false, true]) {
          const inventory: TuiAgent[] = ['claude', 'codex', ...(viable ? candidates : [])]
          const ids = counted(inventory)
          mocks.detection.mockReturnValue({ detectedIds: ids })
          mocks.program.mockReset()
          useAppStore.setState({
            repos: [TEST_REPO],
            worktreesByRepo: { [TEST_REPO.id]: worktrees },
            detectedWorktreesByRepo: {},
            activeWorktreeId: worktreeId,
            activeWorkspaceExecutionHostId: 'local',
            settings: {
              ...getDefaultSettings('/home/me'),
              experimentalNativeChat: true,
              nativeChatProviders: { opencode: false, pi: false, omp: false },
              disabledTuiAgents: []
            }
          })
          resetWork()
          const target = launchCwd
            ? { workspace: { kind: 'git-worktree' as const, worktreeId }, launchCwd }
            : worktreeId
          const hook = renderHook(useOwner, { initialProps: { target, phase: 'static' } })
          console.info('agent menu cold work', {
            owner: useOwner.name,
            count,
            launchCwd,
            viable,
            work: work()
          })
          await act(async () => {})
          const phases =
            useOwner === useTabOwner
              ? ['static', 'search', 'closed', 'hidden', 'loading', 'missing-program', 'settled']
              : useOwner === usePickerOwner
                ? ['static', 'loading', 'missing-program']
                : ['static']
          for (const phase of phases) {
            if (phase === 'hidden') {
              act(() => useAppStore.setState({ activeWorktreeId: 'elsewhere' }))
            }
            mocks.program.mockImplementation((_state, agent) =>
              phase === 'missing-program' && agent !== 'claude' && agent !== 'codex'
                ? 'missing'
                : undefined
            )
            act(() => useAppStore.setState({ detectedAgentIds: phase === 'loading' ? null : ids }))
            mocks.detection.mockReturnValue({ detectedIds: phase === 'loading' ? null : ids })
            const controller = hook.result.current.controller
            if (controller) {
              act(() => {
                controller.setNewTabMenuOpen(!['closed', 'hidden'].includes(phase))
                controller.setCreateMenuQuery(phase === 'search' ? 'opencode' : '')
              })
            }
            hook.rerender({ target, phase })
            resetWork()
            hook.rerender({ target, phase })
            const measured = work(),
              { model, selectionFor } = hook.result.current
            expect(measured.routes).toBe(measured.selectors + 1 + Number(Boolean(launchCwd)))
            if (launchCwd) {
              expect(measured.records).toBeGreaterThanOrEqual(count)
            } else {
              expect(measured.records).toBe(0)
            }
            expect(measured.records).toBeLessThanOrEqual(count * (measured.routes + 8))
            expect(measured.answers).toBe(
              4 +
                (viable && !['loading', 'missing-program'].includes(phase) ? candidates.length : 0)
            )
            expect(measured.metadata).toBe(
              2 + (viable && phase !== 'loading' ? candidates.length : 0)
            )
            expect(measured.programs).toBeLessThanOrEqual(6 * (2 + candidates.length))
            expect(measured.lists + measured.catalogs).toBeLessThanOrEqual(
              200 * (measured.selectors + 1)
            )
            if (phase !== 'loading') {
              expect(model.state).toBe('settled')
              const rows = model.state === 'settled' ? model.rows : []
              expect(rows.filter((row) => row.kind === 'cli' && row.chat)).toHaveLength(
                viable && phase !== 'missing-program' ? candidates.length : 0
              )
              expect(rows).toContainEqual({
                kind: 'chat',
                agent: 'codex',
                executionHostId: 'local'
              })
              const search = findMatchingTabAgentLaunchOptions(
                'opencode',
                buildTabAgentLaunchOptionsFromRows(rows)
              )
              expect(search.map((option) => option.row?.kind)).toEqual(viable ? ['cli'] : [])
            } else {
              expect(model.state).toBe('loading')
            }
            for (const agent of ['codex', ...candidates] as const) {
              selectionFor?.(agent, 'terminal')
            }
            expect(mocks.routes.length).toBe(measured.routes)
            expect(mocks.records).toBe(measured.records)
            expect(mocks.answers.length - measured.answers).toBe(selectionFor ? 4 : 0)
            if (!viable) {
              zero.set(phase, measured)
            } else {
              expect(measured.records).toBe(zero.get(phase)?.records)
            }
            const key = `${useOwner.name}:${launchCwd}:${viable}:${phase}`,
              prior = previous.get(key)
            if (prior) {
              expect(measured.records).toBeLessThanOrEqual(prior.records * 10)
            }
            previous.set(key, measured)
            console.info('agent menu work', {
              owner: useOwner.name,
              count,
              launchCwd,
              viable,
              phase,
              measured
            })
          }
          hook.unmount()
        }
      }
    }
  }
})

it("reads a publishing host's one snapshot, holding a placeholder only until it lands", async () => {
  mocks.publishing = true
  mocks.catalog.mockReturnValue(undefined)
  const hook = renderHook(({ id }) => useNewTabAgentMenuRows(id, false, { kind: 'local' }), {
    initialProps: { id: 'one' }
  })
  const row = (agent: string) =>
    hook.result.current.state === 'settled'
      ? hook.result.current.rows.find((r) => r.agent === agent)
      : undefined
  // Held while the workspace is shown, so the first open already knows.
  expect(mocks.subscribe).toHaveBeenCalledTimes(1)
  expect(mocks.subscribe.mock.calls[0][2]).toEqual({})
  expect(hook.result.current.state).toBe('loading')
  expect(hook.result.current).not.toHaveProperty('rows')

  act(() =>
    mocks.subscribe.mock.calls[0][3].onEvent({
      type: 'availability',
      agents: [
        { agent: 'claude', state: 'refused', reason: 'agent' },
        { agent: 'codex', state: 'available' },
        { agent: 'opencode', state: 'unknown' }
      ]
    })
  )
  expect(row('claude')).toMatchObject({ reason: 'not-on-host' })
  expect(row('codex')).toMatchObject({ kind: 'chat' })

  // Another workspace on the same host reads the same snapshot at once, without a new stream.
  mocks.catalog.mockReturnValue([{ agent: 'gemini', capabilities: {} }])
  act(() => useAppStore.setState({ activeWorktreeId: 'two' }))
  hook.rerender({ id: 'two' })
  // Past the microtask a released holder closes on.
  await act(async () => {})
  expect(row('claude')).toMatchObject({ reason: 'not-on-host' })
  expect(row('gemini')).toMatchObject({ kind: 'cli' })
  expect(mocks.subscribe).toHaveBeenCalledTimes(1)
  expect(mocks.support).not.toHaveBeenCalled()
})

it('shows an older host from client facts and never asks it per agent', () => {
  mocks.publishing = false
  const hook = renderHook(() => useNewTabAgentMenuRows('one', true, { kind: 'local' }))
  expect(
    hook.result.current.state === 'settled' &&
      hook.result.current.rows.find((r) => r.agent === 'claude')
  ).toMatchObject({
    kind: 'chat'
  })
  expect(mocks.subscribe).not.toHaveBeenCalled()
  expect(mocks.support).not.toHaveBeenCalled()
})

it('offers a chat on the CLI row of an agent set to open as a CLI', () => {
  const { settings } = useAppStore.getState()
  useAppStore.setState({
    settings: settings && { ...settings, nativeChatProviders: { claude: false } }
  })
  const hook = renderHook(() => useNewTabAgentMenuRows('one', true, { kind: 'local' }))
  const rows = hook.result.current.state === 'settled' ? hook.result.current.rows : []
  expect(rows.filter((row) => row.agent === 'claude')).toEqual([
    { kind: 'cli', agent: 'claude', chat: true, executionHostId: 'local' }
  ])
  // An agent with no chat on this host keeps a plain CLI row.
  expect(rows).toContainEqual({ kind: 'cli', agent: 'gemini', executionHostId: 'local' })
})

it('waits for a real catalog read, then preserves Gemini CLI after failure without retrying', () => {
  mocks.catalog.mockReturnValue(undefined)
  const hook = renderHook(() => useNewTabAgentMenuRows('one', true, { kind: 'local' }))
  expect(mocks.load).toHaveBeenCalledTimes(1)
  mocks.failed.mockReturnValue(true)
  hook.rerender()
  expect(hook.result.current.state === 'settled' && hook.result.current.rows).toContainEqual({
    kind: 'cli',
    agent: 'gemini',
    executionHostId: 'local'
  })
  expect(mocks.load).toHaveBeenCalledTimes(1)
})

it('settles an initial inventory failure despite pending health and catalog enrichment', () => {
  mocks.publishing = true
  mocks.catalog.mockReturnValue(undefined)
  mocks.detection.mockReturnValue({ detectedIds: null, detectionFailed: true })
  useAppStore.setState({ detectedAgentIds: null })
  const hook = renderHook(() => useNewTabAgentMenuRows('one', true, { kind: 'local' }))
  expect(
    hook.result.current.state === 'settled' &&
      hook.result.current.rows.every(
        (row) => row.kind === 'chat-unavailable' && row.reason === 'check-failed'
      )
  ).toBe(true)
})

it('holds initial capability acquisition, then exposes truthful failure and known CLI without a retry loop', async () => {
  setLocalRuntimeCapabilitiesForTests(null)
  const status = Promise.withResolvers<never>()
  const getStatus = vi.fn(() => status.promise)
  Object.assign(window, { api: { runtime: { getStatus } } })
  const hook = renderHook(() => useNewTabAgentMenuRows('one', true, { kind: 'local' }))
  await act(async () => {
    status.reject(new Error('host unreachable'))
  })
  expect(hook.result.current.state === 'settled' && hook.result.current.rows).toContainEqual({
    kind: 'chat-unavailable',
    agent: 'claude',
    reason: 'check-failed',
    executionHostId: 'local'
  })
  expect(hook.result.current.state === 'settled' && hook.result.current.rows).toContainEqual({
    kind: 'cli',
    agent: 'gemini',
    executionHostId: 'local'
  })
  expect(getStatus).toHaveBeenCalledTimes(1)
})

// Last: the host's published snapshot is module state that later cases would read.
it('preserves per-agent published answers and direct route inputs across context changes', async () => {
  mocks.realRoutes = true
  mocks.publishing = true
  setLocalRuntimeCapabilitiesForTests([CHAT, CLIENT, CATALOG, AVAILABILITY])
  mocks.detection.mockReturnValue({ detectedIds: ['claude'] })
  const status: RuntimeEnvironmentStatus = {
    checkedAt: 1,
    status: {
      runtimeId: 'prepared-context',
      capabilities: [CHAT, CLIENT, CATALOG, AVAILABILITY],
      rendererGraphEpoch: 0,
      graphStatus: 'ready',
      authoritativeWindowId: null,
      liveTabCount: 0,
      liveLeafCount: 0
    }
  }
  const hook = renderHook(
    ({ target }: { target: AgentMenuRowsTarget }) => {
      const detection = useAgentDetectionTargetForWorktree(target.workspace.worktreeId ?? null)
      return useAgentMenuObservation(target, true, detection)
    },
    { initialProps: { target: { workspace: { kind: 'git-worktree', worktreeId: 'one' } } } }
  )
  for (const host of ['local', 'runtime:prepared'] as const) {
    for (const folder of [false, true]) {
      const worktreeId = folder ? 'folder:f1' : 'one'
      act(() =>
        useAppStore.setState({
          activeWorktreeId: worktreeId,
          activeWorkspaceExecutionHostId: host,
          worktreesByRepo: {
            [TEST_REPO.id]: [
              makeWorktree({ id: 'one', repoId: TEST_REPO.id, hostId: host, path: '/work' })
            ]
          },
          folderWorkspaces: [
            makeFolderWorkspace({ id: 'f1', executionHostId: host, folderPath: '/work' })
          ],
          repos: [TEST_REPO],
          runtimeStatusByEnvironmentId: new Map([['prepared', status]])
        })
      )
      for (const launchCwd of [undefined, '/work/.', '/work/sub']) {
        const target: AgentMenuRowsTarget = {
          workspace: { kind: folder ? 'folder' : 'git-worktree', worktreeId },
          launchCwd
        }
        mocks.program.mockClear()
        hook.rerender({ target })
        await act(async () => {})
        expect(mocks.program.mock.calls.length).toBeGreaterThan(0)
        for (const [, , baseline] of mocks.program.mock.calls) {
          expect(baseline).toHaveProperty('startsOutsideWorkspaceRoot', false)
        }
        for (const refused of ['claude', 'codex'] as const) {
          const stream = mocks.subscribe.mock.calls.findLast((call) =>
            host === 'local' ? call[0].kind === 'local' : call[0].environmentId === 'prepared'
          )
          expect(stream).toBeDefined()
          act(() =>
            stream![3].onEvent({
              type: 'availability',
              agents: ['claude', 'codex'].map((agent) => ({
                agent,
                state: agent === refused ? 'refused' : 'available',
                reason: 'agent',
                chatProgram: 'installable'
              }))
            })
          )
          for (const agent of ['claude', 'codex'] as const) {
            mocks.answers.length = 0
            const before = mocks.routes.length
            const selection = hook.result.current.selectionFor(agent)
            expect(mocks.routes.length).toBe(before)
            const expected = actualRouteInput.buildAgentLaunchRouteInput(useAppStore.getState(), {
              agent,
              workspace: target.workspace,
              ...(launchCwd ? { tuiCustomization: { cwd: launchCwd } } : {})
            })
            expected.hostStructuredAgents = ['claude', 'codex']
            expect(mocks.answers).toEqual([expected])
            expect(selection.ready).toBe(
              agent === 'claude' || (launchCwd !== '/work/sub' && agent !== refused)
            )
            expect(selection.choice).toMatchObject({
              agent,
              executionHostId: host,
              route:
                launchCwd === '/work/sub' || agent === refused
                  ? 'terminal-tui'
                  : 'structured-native-chat'
            })
          }
          if (!launchCwd && refused === 'claude') {
            expect(
              hook.result.current.model.state === 'settled' && hook.result.current.model.rows
            ).toContainEqual({ kind: 'chat', agent: 'codex', executionHostId: host })
            expect(hook.result.current.selectionFor('codex', 'terminal').ready).toBe(false)
          }
        }
      }
    }
  }
})
