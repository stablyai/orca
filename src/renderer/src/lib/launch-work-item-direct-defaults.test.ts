import { EVERY_AGENT_CHAT } from '../../../shared/native-chat/every-agent-chat.test-fixture'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mocks, hostMocks } from './launch-work-item-direct-test-fixture'
import * as hostPreferences from '@/components/settings/use-host-agent-launch-preferences'
import { resolveProjectExecutionRuntime } from '../../../shared/project-execution-runtime'
import { getRepoExecutionHostId } from '../../../shared/execution-host'
import type { ProjectLaunchContext } from '../../../shared/rpc-contract/preflight-params'
import type { Repo } from '../../../shared/repo-types'
import * as inventory from './agent-detection-target-inventory'
import * as localCapabilities from '@/runtime/local-runtime-capabilities'
import { resetHostStructuredAgentsForTests } from '@/runtime/host-structured-agents'
import {
  clearHostAgentMenuSettingsForTests,
  ensureAgentLaunchPreferences
} from '@/components/settings/use-host-agent-launch-preferences'
import { projectAgentLaunchSettings } from '../../../shared/agent-launch-settings'
import { createCompatibleRuntimeStatusResponse } from '@/runtime/runtime-compatibility-test-fixture'
import { makeWorktree } from '@/store/slices/worktrees-slice-test-fixtures'
import { useAppStore } from '@/store'
import * as worktreeRows from '@/store/slices/worktree-helpers'
import * as routeInputs from './agent-launch-route-input'
import * as chatPrograms from './host-chat-program'
import * as chatAcquisition from './host-chat-program-acquisition'
import { resolveDirectProspectiveAgent } from './launch-work-item-direct-preflight'
import * as availability from '@/runtime/host-structured-agent-availability'
import { RUNTIME_CAPABILITIES } from '../../../shared/protocol-version'
import { launchWorkItemDirect } from './launch-work-item-direct'
import { beginDirectWorkItemStructuredLaunch } from './launch-work-item-direct-agent-routing'

const item = {
  type: 'issue',
  number: 42,
  title: 'Use the preferred chat',
  url: 'https://github.com/acme/repo/issues/42'
} as const
const launch = (extra: Partial<Parameters<typeof launchWorkItemDirect>[0]> = {}) =>
  launchWorkItemDirect({
    repoId: 'repo-1',
    launchSource: 'task_page',
    openModalFallback: mocks.openModalFallback,
    item,
    ...extra
  })

function stageChat() {
  localCapabilities.setLocalRuntimeCapabilitiesForTests(RUNTIME_CAPABILITIES)
  hostMocks.callRuntimeRpc.mockResolvedValue({
    agents: ['codex', 'claude'].map((agent) => ({ agent, capabilities: {} }))
  })
  vi.mocked(beginDirectWorkItemStructuredLaunch).mockImplementation(({ plan, beforeOpen }) =>
    plan?.route === 'structured-native-chat'
      ? { completed: beforeOpen() !== false, structuredLaunch: true, primaryTabId: 'chat-tab' }
      : { completed: false, structuredLaunch: false, primaryTabId: null }
  )
}
afterEach(() => {
  resetHostStructuredAgentsForTests()
  clearHostAgentMenuSettingsForTests()
  localCapabilities.setLocalRuntimeCapabilitiesForTests(null)
})

describe('direct workspace defaults', () => {
  it.each(['codex', 'claude'] as const)(
    'keeps a usable preferred Codex chat over detected Claude, then honors the current default (%s)',
    async (currentDefault) => {
      const projectContext = {
        agents: ['claude'],
        workspaceKind: 'git-worktree',
        executionContext: {
          kind: 'host',
          projectRuntime: resolveProjectExecutionRuntime({ appPlatform: 'darwin', projectId: 'p1' })
        }
      } satisfies ProjectLaunchContext
      vi.spyOn(inventory, 'loadProjectLaunchContext').mockResolvedValue(projectContext)
      stageChat()
      hostMocks.callRuntimeRpc.mockResolvedValue({ agents: [{ agent: 'codex', capabilities: {} }] })
      mocks.ensureDetectedAgents.mockResolvedValue(['claude'])
      mocks.store.settings = { defaultTuiAgent: 'codex', nativeChatProviders: EVERY_AGENT_CHAT }
      useAppStore.setState({
        readLocalAgentInventory: () => ({ state: 'successful', ids: ['claude'] })
      })
      const unsubscribe = vi.fn()
      const subscriptionHandle = Promise.resolve({ unsubscribe })
      let delivered = false
      hostMocks.subscribe.mockImplementation((_target, _method, _params, handlers) => {
        queueMicrotask(() => {
          handlers.onEvent({
            type: 'availability',
            agents: [{ agent: 'codex', state: 'available', chatProgram: 'available' }]
          })
          delivered = true
        })
        return subscriptionHandle
      })
      mocks.createWorktree.mockImplementationOnce(async () => {
        const worktree = makeWorktree({
          id: 'repo-1::/repo/worktree',
          path: '/repo/worktree',
          repoId: 'repo-1'
        })
        mocks.store.settings = {
          defaultTuiAgent: currentDefault,
          nativeChatProviders: EVERY_AGENT_CHAT
        }
        useAppStore.setState({
          worktreesByRepo: { 'repo-1': [worktree] }
        })
        return { worktree }
      })
      vi.mocked(beginDirectWorkItemStructuredLaunch).mockImplementationOnce(({ beforeOpen }) => ({
        completed: beforeOpen() !== false,
        structuredLaunch: true,
        primaryTabId: 'chat-tab'
      }))

      const state = useAppStore.getState()
      const repo = state.repos[0]
      const prospective = {
        kind: projectContext.workspaceKind,
        repoId: repo.id,
        executionHostId: getRepoExecutionHostId(repo),
        executionContext: projectContext.executionContext
      }
      const owner = chatPrograms.resolveChatProgramContext(state, prospective)
      const seed = chatAcquisition.holdChatProgramFacts(owner)
      try {
        expect(hostMocks.subscribe).toHaveBeenCalledOnce()
        await Promise.all([seed.catalog, seed.first()])
        expect(delivered).toBe(true)
        expect(
          availability.readHostStructuredAgentAvailability(
            owner.executionHostId,
            owner.runtimeId,
            owner.pairingRevision
          )
        ).toEqual({
          state: 'received',
          byAgent: new Map([
            ['codex', { agent: 'codex', state: 'available', chatProgram: 'available' }]
          ])
        })
        expect(
          chatPrograms.agentChoiceOpensAsChat(useAppStore.getState(), 'codex', prospective, [
            'claude'
          ])
        ).toBe(true)
        const acquisition = vi.spyOn(chatAcquisition, 'acquireAgentLaunchChoices')
        const offers = vi.spyOn(chatPrograms, 'agentsOfferedForLaunch')
        const plannedAgents: string[] = []
        await expect(
          launch({
            resolveSessionOptions: (agent) => {
              plannedAgents.push(agent)
              return undefined
            }
          })
        ).resolves.toBe(true)

        expect(plannedAgents).toEqual(['codex', currentDefault])
        expect(mocks.updateWorktreeMeta).toHaveBeenCalledWith('repo-1::/repo/worktree', {
          createdWithAgent: currentDefault
        })
        expect(beginDirectWorkItemStructuredLaunch).toHaveBeenCalledWith(
          expect.objectContaining({
            plan: expect.objectContaining({
              agent: currentDefault,
              route: 'structured-native-chat',
              worktreeId: 'repo-1::/repo/worktree',
              prompt: item.url,
              promptDelivery: 'draft'
            })
          })
        )
        expect(
          vi.mocked(beginDirectWorkItemStructuredLaunch).mock.lastCall?.[0].plan?.launchOptions
        ).toBeUndefined()
        expect(mocks.activateAndRevealWorktree).toHaveBeenCalledOnce()
        expect(mocks.activateAndRevealWorktree).toHaveBeenCalledWith(
          'repo-1::/repo/worktree',
          expect.objectContaining({ providesInitialSurface: true })
        )
        if (currentDefault === 'codex') {
          expect(acquisition).toHaveBeenCalledOnce()
          await expect(acquisition.mock.results[0].value).resolves.toEqual({
            detected: ['claude'],
            offered: ['claude', 'codex']
          })
          expect(offers).toHaveBeenCalledOnce()
          expect(offers.mock.results[0].value).toEqual(['claude', 'codex'])
        } else {
          expect(acquisition).not.toHaveBeenCalled()
          expect(offers).not.toHaveBeenCalled()
        }
        expect(hostMocks.subscribe).toHaveBeenCalledOnce()
        expect(unsubscribe).not.toHaveBeenCalled()
      } finally {
        seed.release()
        await Promise.resolve()
        await subscriptionHandle
        expect(unsubscribe).toHaveBeenCalledOnce()
      }
    }
  )

  it('uses prospective native facts to ignore hidden args before create', async () => {
    vi.spyOn(inventory, 'loadProjectLaunchContext').mockResolvedValue({
      agents: ['codex'],
      workspaceKind: 'git-worktree',
      executionContext: {
        kind: 'host',
        projectRuntime: resolveProjectExecutionRuntime({
          appPlatform: 'darwin',
          projectId: 'p1'
        })
      }
    })
    vi.spyOn(localCapabilities, 'readLocalRuntimeCapabilitiesOrUnknown').mockReturnValue(
      RUNTIME_CAPABILITIES
    )
    mocks.store.settings = { nativeChatProviders: EVERY_AGENT_CHAT, disabledTuiAgents: ['codex'] }
    vi.mocked(beginDirectWorkItemStructuredLaunch).mockImplementationOnce(({ beforeOpen }) => ({
      completed: beforeOpen() !== false,
      structuredLaunch: true,
      primaryTabId: 'chat-tab'
    }))
    await launchWorkItemDirect({
      repoId: 'repo-1',
      launchSource: 'task_page',
      openModalFallback: vi.fn(),
      agentLaunchPreferences: { defaultTuiAgent: 'codex', disabledTuiAgents: undefined },
      agentArgs: '--model "unterminated',
      resolveSessionOptions: () => ({ model: 'chosen' }),
      item: {
        type: 'issue',
        number: 42,
        title: 'Fix',
        url: 'https://github.com/acme/repo/issues/42'
      }
    })
    expect(mocks.createWorktree).toHaveBeenCalledOnce()
    expect(
      vi.mocked(beginDirectWorkItemStructuredLaunch).mock.calls.at(-1)?.[0].plan?.launchOptions
    ).toEqual({ model: 'chosen' })
  })
  it.each([undefined, 'codex'] as const)(
    'uses actual WSL inventory after native project preflight (override %s)',
    async (agentOverride) => {
      localCapabilities.setLocalRuntimeCapabilitiesForTests([])
      const path = String.raw`\\wsl.localhost\Ubuntu\workspaces\task`
      const worktree = makeWorktree({ id: `repo-1::${path}`, path, repoId: 'repo-1' })
      mocks.store.repos = [
        { id: 'repo-1', path: String.raw`C:\src\repo`, addedAt: 1, displayName: 'Repo' }
      ]
      vi.spyOn(inventory, 'loadProjectLaunchContext').mockResolvedValue({
        agents: ['codex'],
        workspaceKind: 'git-worktree',
        executionContext: {
          kind: 'host',
          projectRuntime: resolveProjectExecutionRuntime({
            appPlatform: 'win32',
            projectId: 'repo-1'
          })
        }
      })
      mocks.ensureDetectedAgents.mockResolvedValue(['claude'])
      mocks.createWorktree.mockImplementationOnce(async () => {
        useAppStore.setState({ worktreesByRepo: { 'repo-1': [worktree] } })
        return { worktree }
      })
      await expect(launch({ agentOverride })).resolves.toBe(agentOverride === undefined)
      expect(mocks.ensureDetectedAgents).toHaveBeenCalledWith(worktree.id)
      if (agentOverride) {
        expect(mocks.toastError).toHaveBeenCalledWith(expect.any(String))
        expect(mocks.updateWorktreeMeta).not.toHaveBeenCalled()
      } else {
        expect(mocks.updateWorktreeMeta).toHaveBeenCalledWith(worktree.id, {
          createdWithAgent: 'claude'
        })
        expect(mocks.activateAndRevealWorktree.mock.lastCall?.[1].startup).toMatchObject({
          launchAgent: 'claude'
        })
        expect(mocks.activateAndRevealWorktree.mock.lastCall?.[1].startup.command).toContain(
          'claude'
        )
      }
    }
  )

  it.each([false, true])(
    'uses cached owner defaults and preserves supplied preferences (%s)',
    async (supplied) => {
      stageChat()
      const repo = {
        id: 'repo-1',
        path: '/repo',
        executionHostId: 'runtime:alpha',
        addedAt: 1,
        displayName: 'Repo',
        badgeColor: '#000000'
      } satisfies Repo
      const status = {
        ...createCompatibleRuntimeStatusResponse('r1').result,
        hostPlatform: 'linux' as const
      }
      useAppStore.setState({
        repos: [repo],
        runtimeStatusByEnvironmentId: new Map([['alpha', { status, checkedAt: 1 }]]),
        ensureRuntimeDetectedAgents: async () => ['claude', 'codex']
      })
      mocks.store.settings = { defaultTuiAgent: 'claude', nativeChatProviders: EVERY_AGENT_CHAT }
      hostMocks.supports.mockResolvedValue(true)
      hostMocks.callRuntimeRpc.mockResolvedValue({
        settings: projectAgentLaunchSettings({ defaultTuiAgent: 'codex' })
      })
      const acquiredPreferences = await ensureAgentLaunchPreferences(useAppStore.getState(), {
        kind: 'git-worktree',
        repoId: repo.id,
        executionHostId: repo.executionHostId
      })
      expect(acquiredPreferences.defaultTuiAgent).toBe('codex')
      vi.spyOn(inventory, 'loadProjectLaunchContext').mockResolvedValue(undefined)
      hostMocks.callRuntimeRpc.mockClear()
      mocks.createWorktree.mockImplementationOnce(async () => {
        const worktree = makeWorktree({
          id: 'repo-1::/repo/worktree',
          path: '/repo/worktree',
          repoId: repo.id,
          hostId: repo.executionHostId
        })
        useAppStore.setState({ worktreesByRepo: { [repo.id]: [worktree] } })
        return { worktree }
      })
      const agent = supplied ? 'claude' : 'codex'
      await expect(
        launch(
          supplied
            ? { agentLaunchPreferences: { defaultTuiAgent: 'claude', disabledTuiAgents: [] } }
            : {}
        )
      ).resolves.toBe(true)
      expect(mocks.updateWorktreeMeta).toHaveBeenCalledWith('repo-1::/repo/worktree', {
        createdWithAgent: agent
      })
      expect(beginDirectWorkItemStructuredLaunch).toHaveBeenCalledWith(
        expect.objectContaining({
          plan: expect.objectContaining({ agent, route: 'structured-native-chat' })
        })
      )
      expect(hostMocks.callRuntimeRpc).not.toHaveBeenCalled()
    }
  )

  it('uses the post-availability snapshot for changed default, route and startup settings', async () => {
    stageChat()
    mocks.store.settings = { defaultTuiAgent: 'codex', nativeChatProviders: EVERY_AGENT_CHAT }
    mocks.ensureDetectedAgents.mockResolvedValue(['claude'])
    const opened = Promise.withResolvers<Parameters<typeof hostMocks.subscribe>[3]>()
    const unsubscribe = vi.fn()
    hostMocks.subscribe.mockImplementation(async (_target, _method, _params, handlers) => {
      opened.resolve(handlers)
      return { unsubscribe }
    })
    vi.spyOn(inventory, 'loadProjectLaunchContext').mockResolvedValue({
      agents: ['claude'],
      workspaceKind: 'git-worktree',
      executionContext: {
        kind: 'host',
        projectRuntime: resolveProjectExecutionRuntime({
          appPlatform: 'darwin',
          projectId: 'repo-1'
        })
      }
    })
    const action = launch()
    const handlers = await opened.promise
    useAppStore.setState({
      settings: {
        ...useAppStore.getState().settings!,
        defaultTuiAgent: 'claude',
        nativeChatProviders: {},
        agentCmdOverrides: { claude: 'custom-claude' }
      }
    })
    handlers.onEvent({
      type: 'availability',
      agents: [{ agent: 'codex', state: 'available', chatProgram: 'available' }]
    })
    await expect(action).resolves.toBe(true)
    expect(beginDirectWorkItemStructuredLaunch).toHaveBeenCalledWith(
      expect.objectContaining({
        plan: expect.objectContaining({
          agent: 'claude',
          route: 'terminal-tui',
          prompt: item.url,
          promptDelivery: 'draft'
        })
      })
    )
    expect(mocks.activateAndRevealWorktree.mock.lastCall?.[1].startup.command).toContain(
      'custom-claude'
    )
    expect(mocks.updateWorktreeMeta).toHaveBeenCalledWith('repo-1::/repo/worktree', {
      createdWithAgent: 'claude'
    })
    expect(hostMocks.subscribe).toHaveBeenCalledOnce()
    expect(unsubscribe).toHaveBeenCalledOnce()
  })

  it.each(['blank', 'codex'] as const)(
    'keeps blank creation and disabled preferred fallback (%s)',
    async (defaultTuiAgent) => {
      mocks.store.settings = {
        defaultTuiAgent,
        disabledTuiAgents: ['codex'],
        nativeChatProviders: {}
      }
      mocks.ensureDetectedAgents.mockResolvedValue(['claude', 'codex'])
      await expect(launch()).resolves.toBe(true)
      const selected = defaultTuiAgent === 'blank' ? undefined : 'claude'
      expect(mocks.activateAndRevealWorktree.mock.lastCall?.[1].startup?.launchAgent).toBe(selected)
    }
  )

  it('matches new-tab unavailable fallback through the moved prospective selector', async () => {
    const { resolveDefaultAgentForNewTab } = await import('./agent-tab-shortcuts')
    mocks.store.settings = { defaultTuiAgent: 'codex', nativeChatProviders: {} }
    mocks.ensureDetectedAgents.mockResolvedValue([])
    const store = useAppStore.getState()
    const prospective = await resolveDirectProspectiveAgent(store, store.repos[0], undefined, {})
    expect(prospective.prospectiveAgent).toBe(
      resolveDefaultAgentForNewTab({
        defaultTuiAgent: 'codex',
        detectedAgentIds: [],
        disabledTuiAgents: []
      })
    )
    expect(prospective.prospectiveAgent).toBeNull()
  })

  it.each([100, 1000])(
    'bounds real default acquisition without root traversal over %s worktrees',
    async (n) => {
      stageChat()
      mocks.store.settings = { defaultTuiAgent: 'codex', nativeChatProviders: EVERY_AGENT_CHAT }
      const rows = Array.from({ length: n }, (_, i) =>
        makeWorktree({ id: `repo-1::/repo/w${i}`, path: `/repo/w${i}`, repoId: 'repo-1' })
      )
      const target = rows[n - 1]
      useAppStore.setState({
        worktreesByRepo: { 'repo-1': rows },
        readLocalAgentInventory: () => ({ state: 'successful', ids: ['claude'] })
      })
      mocks.ensureDetectedAgents.mockResolvedValue(['claude'])
      mocks.createWorktree.mockResolvedValue({ worktree: target })
      vi.spyOn(inventory, 'loadProjectLaunchContext').mockResolvedValue({
        agents: ['claude'],
        workspaceKind: 'git-worktree',
        executionContext: {
          kind: 'host',
          projectRuntime: resolveProjectExecutionRuntime({
            appPlatform: 'darwin',
            projectId: 'repo-1'
          })
        }
      })
      const unsubscribe = vi.fn()
      hostMocks.subscribe.mockImplementation(async (_target, _method, _params, handlers) => {
        queueMicrotask(() =>
          handlers.onEvent({
            type: 'availability',
            agents: ['codex', 'claude'].map((agent) => ({
              agent,
              state: 'available',
              chatProgram: 'available'
            }))
          })
        )
        return { unsubscribe }
      })
      const offers = vi.spyOn(chatPrograms, 'agentsOfferedForLaunch')
      const routes = vi.spyOn(routeInputs, 'buildAgentLaunchRouteInput')
      let inRootLookup = false,
        visits = 0
      const find = rows.find
      vi.spyOn(rows, 'find').mockImplementation((predicate, thisArg) =>
        find.call(rows, (row, index, array) => {
          if (inRootLookup) {
            visits++
          }
          return predicate.call(thisArg, row, index, array)
        })
      )
      const lookup = worktreeRows.findWorktreeById
      const roots = vi.spyOn(worktreeRows, 'findWorktreeById').mockImplementation((byRepo, id) => {
        inRootLookup = true
        try {
          return lookup(byRepo, id)
        } finally {
          inRootLookup = false
        }
      })
      await expect(launch()).resolves.toBe(true)
      expect(offers).toHaveBeenCalledOnce()
      expect(offers.mock.results[0].value).toEqual(['claude', 'codex'])
      expect(routes.mock.calls.length).toBeGreaterThanOrEqual(2)
      expect(routes.mock.calls.length).toBeLessThanOrEqual(20)
      for (const cwd of [undefined, null, '', '  ']) {
        expect(
          routeInputs.buildAgentLaunchRouteInput(useAppStore.getState(), {
            agent: 'codex',
            workspace: { kind: 'git-worktree', worktreeId: target.id },
            tuiCustomization: { cwd }
          }).startsOutsideWorkspaceRoot
        ).toBe(false)
      }
      expect(roots).not.toHaveBeenCalled()
      expect(visits).toBe(0)
      expect(mocks.updateWorktreeMeta).toHaveBeenCalledWith(target.id, {
        createdWithAgent: 'codex'
      })
      expect(beginDirectWorkItemStructuredLaunch).toHaveBeenCalledWith(
        expect.objectContaining({
          plan: expect.objectContaining({ agent: 'codex', route: 'structured-native-chat' })
        })
      )
      expect(hostMocks.subscribe).toHaveBeenCalledOnce()
      expect(unsubscribe).toHaveBeenCalledOnce()
    }
  )
})

it.each(['native', 'blank', 'terminal'] as const)(
  'acquires terminal preferences only for an actual terminal consumer (%s)',
  async (route) => {
    stageChat()
    mocks.store.settings = {
      defaultTuiAgent: route === 'blank' ? 'blank' : 'codex',
      nativeChatProviders: route === 'native' ? EVERY_AGENT_CHAT : {}
    }
    vi.spyOn(inventory, 'loadProjectLaunchContext').mockResolvedValue(undefined)
    const answer = Promise.withResolvers<Awaited<ReturnType<typeof ensureAgentLaunchPreferences>>>()
    const ensure = vi
      .spyOn(hostPreferences, 'ensureAgentLaunchPreferences')
      .mockReturnValue(answer.promise)
    try {
      const action = launch()
      if (route === 'terminal') {
        await vi.waitFor(() => expect(ensure).toHaveBeenCalledOnce())
        expect(mocks.activateAndRevealWorktree).not.toHaveBeenCalled()
        answer.resolve({
          defaultTuiAgent: 'codex',
          disabledTuiAgents: undefined,
          agentLaunchChoices: { codex: { model: 'owner-result' } }
        })
      }
      await expect(action).resolves.toBe(true)
      if (route !== 'terminal') {
        expect(ensure).not.toHaveBeenCalled()
      }
      if (route === 'native') {
        expect(beginDirectWorkItemStructuredLaunch).toHaveBeenCalledWith(
          expect.objectContaining({
            plan: expect.objectContaining({ route: 'structured-native-chat' })
          })
        )
      } else if (route === 'terminal') {
        expect(mocks.activateAndRevealWorktree.mock.lastCall?.[1].startup.command).toContain(
          'owner-result'
        )
      } else {
        expect(mocks.activateAndRevealWorktree.mock.lastCall?.[1].startup).toBeUndefined()
      }
    } finally {
      answer.resolve({ defaultTuiAgent: undefined, disabledTuiAgents: undefined })
    }
  }
)
