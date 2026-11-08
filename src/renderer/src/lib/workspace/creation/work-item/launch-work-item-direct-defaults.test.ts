import { EVERY_AGENT_CHAT } from '../../../../../../shared/native-chat/every-agent-chat.test-fixture'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mocks, hostMocks } from './launch-work-item-direct-test-fixture'

import { resolveProjectExecutionRuntime } from '../../../../../../shared/project-execution-runtime'

import * as inventory from '../../../agent-detection-target-inventory'
import * as localCapabilities from '@/runtime/hosts/capabilities/local-runtime-capabilities'
import { resetHostStructuredAgentsForTests } from '@/runtime/native-chat/agent-catalogs/host-structured-agents'
import { clearHostAgentMenuSettingsForTests } from '@/runtime/agent-launch-settings/host-agent-launch-preferences-resource'

import { makeWorktree } from '@/store/slices/worktrees/worktree.test-fixture'
import { useAppStore } from '@/store/index'

import { RUNTIME_CAPABILITIES } from '../../../../../../shared/protocol-version'
import { projectSourceControlActionLaunch } from '../../../../../../shared/source-control/ai/recipes/source-control-action-launch-preferences'
import { tokenizeStartupCommand } from '../../../../../../shared/agent-launch/startup/tui-agent-startup-shell'
import { runSourceControlAgentActionStart } from '../../../../components/right-sidebar/source-control/ai/runSourceControlAgentActionStart'
import { startFixChecksFromDialog } from '../../../../components/pull-request-page/checks/fix-launch'
import { sourceControlActionRecipeEntry } from '../../../../../../shared/source-control/ai/recipes/source-control-action-selection'
import { pr } from '@/hooks/composer-state/composer-review-base-test-fixture'
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
  it('plans a saved Chat preference before creation under CLI settings and carries both captured views', async () => {
    stageChat()
    mocks.store.settings = { defaultTuiAgent: 'codex', nativeChatProviders: { codex: false } }
    const recipe = {
      agentId: 'codex' as const,
      surface: 'chat' as const,
      agentArgs: '--model "unterminated',
      launchPreferences: {
        agentId: 'codex' as const,
        model: 'gpt-5.5',
        options: { effort: 'high' }
      }
    }
    await expect(
      launch({
        agentOverride: 'codex',
        resolveLaunchInputs: (agent) =>
          projectSourceControlActionLaunch(recipe, agent, { basePrompt: item.url })
      })
    ).resolves.toBe(true)
    expect(mocks.createWorktree).toHaveBeenCalledOnce()
    const plan = vi.mocked(beginDirectWorkItemStructuredLaunch).mock.lastCall?.[0].plan
    expect(plan).toMatchObject({
      agent: 'codex',
      route: 'structured-native-chat',
      launchOptions: { model: 'gpt-5.5', effort: 'high' }
    })
    expect(plan).not.toHaveProperty('requestedSurface')
    expect(plan?.chatLaunchOptions).toBeUndefined()
    expect(mocks.openModalFallback).not.toHaveBeenCalled()
  })

  it('dispatches saved Chat through the actual custom Checks runner with its paired native alternative', async () => {
    stageChat()
    mocks.store.settings = { defaultTuiAgent: 'codex', nativeChatProviders: { codex: false } }
    const recipe = sourceControlActionRecipeEntry({
      agentId: 'codex',
      surface: 'chat',
      agentArgs: `-c 'model="true"'`,
      launchPreferences: {
        agentId: 'codex',
        modelSelection: {
          base: 'default',
          options: { effort: { agentId: 'codex', value: 'high' } }
        }
      }
    })
    await expect(
      runSourceControlAgentActionStart({
        recipe,
        selectedAgent: 'codex',
        trimmedCommandInput: 'Fix checks',
        saveTargetValue: 'none',
        actionId: 'fixChecks',
        repoId: 'repo-1',
        repo: null,
        promptDelivery: 'submit-after-ready',
        launchPlatform: 'darwin',
        launchSource: 'task_page',
        onStart: (launch) =>
          startFixChecksFromDialog({
            ...launch,
            targetRepoId: 'repo-1',
            item: { ...pr, repoId: 'repo-1' }
          }),
        onClose: vi.fn()
      })
    ).resolves.toBe(true)
    const plan = vi.mocked(beginDirectWorkItemStructuredLaunch).mock.lastCall?.[0].plan
    expect(plan).toMatchObject({
      agent: 'codex',
      route: 'structured-native-chat',
      launchOptions: { effort: 'high' },
      chatLaunchOptions: { model: 'true', effort: 'high' }
    })
    expect(plan).not.toHaveProperty('requestedSurface')
    expect(mocks.createWorktree).toHaveBeenCalledOnce()
    expect(mocks.openModalFallback).not.toHaveBeenCalled()
  })

  it('reprojects one captured saved source for the actual agent after delayed workspace creation', async () => {
    localCapabilities.setLocalRuntimeCapabilitiesForTests([])
    mocks.store.settings = { defaultTuiAgent: 'claude', nativeChatProviders: {} }
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
    const live = {
      agentId: 'claude' as const,
      surface: 'chat' as const,
      agentArgs: `-c 'model="true"'`,
      launchPreferences: {
        agentId: 'codex' as const,
        modelSelection: {
          base: 'default' as const,
          options: { effort: { agentId: 'codex' as const, value: 'high' } }
        }
      }
    }
    const captured = structuredClone(live)
    const created = Promise.withResolvers<Awaited<ReturnType<typeof mocks.createWorktree>>>()
    mocks.createWorktree.mockReturnValueOnce(created.promise)
    const agents: string[] = []
    const action = launch({
      resolveLaunchInputs: (agent) => {
        agents.push(agent)
        return projectSourceControlActionLaunch(captured, agent, { basePrompt: item.url })
      }
    })
    await vi.waitFor(() => expect(mocks.createWorktree).toHaveBeenCalledOnce())
    live.agentArgs = '--model later-form'
    live.launchPreferences.modelSelection.options.effort.value = 'low'
    const worktree = makeWorktree({
      id: 'repo-1::/repo/worktree',
      path: '/repo/worktree',
      repoId: 'repo-1'
    })
    mocks.store.settings = {
      defaultTuiAgent: 'codex',
      nativeChatProviders: {},
      agentCmdOverrides: { codex: 'cx' }
    }
    mocks.ensureDetectedAgents.mockResolvedValue(['codex'])
    useAppStore.setState({ worktreesByRepo: { 'repo-1': [worktree] } })
    created.resolve({ worktree })
    await expect(action).resolves.toBe(true)
    expect(agents).toEqual(['claude', 'codex'])
    const startup = mocks.activateAndRevealWorktree.mock.lastCall?.[1].startup
    const parsed = tokenizeStartupCommand(startup.command, 'posix')
    expect(parsed).toMatchObject({
      ok: true,
      tokens: ['cx', '-c', 'model="true"', '-c', 'model_reasoning_effort=high']
    })
    expect(startup.launchConfig.agentArgs).toBe(`-c 'model="true"'`)
    expect(JSON.stringify(startup)).not.toContain('later-form')
    expect(JSON.stringify(startup)).not.toContain('chatSessionOptions')
    expect(JSON.stringify(startup)).not.toContain('chatLaunchOptions')
  })

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
})

it.each(['dialog', 'saved-action'] as const)(
  'keeps raw Fix Checks Arguments through %s creation and the real paired pane selector',
  async (source) => {
    const { createRemoteRuntimePtyTransport } =
      await import('@/components/terminal-pane/pty-transport/remote-runtime/remote-runtime-pty-transport')
    mocks.ensureDetectedAgents.mockResolvedValue(['claude'])
    mocks.ensureRemoteDetectedAgents.mockResolvedValue(['claude'])
    mocks.store.settings = {
      defaultTuiAgent: 'claude',
      agentPermissionDefault: 'own',
      agentCmdOverrides: { claude: '/desktop/claude' },
      nativeChatProviders: {}
    }
    mocks.store.repos = [{ id: 'repo-1', path: '/repo', executionHostId: 'runtime:host' }]
    mocks.store.ensureRuntimeDetectedAgents = vi.fn(async () => ['claude'])
    mocks.store.runtimeDetectedAgents = { host: ['claude'] }
    mocks.store.runtimeStatusByEnvironmentId = new Map([
      ['host', { status: { runtimeId: 'rt', hostPlatform: 'linux' } }]
    ])
    const hostSettings = {
      defaultTuiAgent: 'claude',
      disabledTuiAgents: [],
      agentCmdOverrides: { claude: '/host/claude' },
      agentDefaultArgs: { claude: '--dangerously-skip-permissions' },
      environmentNames: {},
      permissionMode: 'mixed' as const
    }
    hostMocks.supports.mockResolvedValue(true)
    hostMocks.callRuntimeRpc.mockImplementation(async (_target, method) =>
      method === 'settings.getAgentLaunch' ? { settings: hostSettings } : { agents: ['claude'] }
    )
    vi.spyOn(inventory, 'loadProjectLaunchContext').mockResolvedValue(undefined)
    const recipe = sourceControlActionRecipeEntry({ agentId: 'claude', agentArgs: '--verbose' })
    await (source === 'dialog'
      ? runSourceControlAgentActionStart({
          recipe,
          selectedAgent: 'claude',
          trimmedCommandInput: 'Fix checks',
          saveTargetValue: 'none',
          actionId: 'fixChecks',
          repoId: 'repo-1',
          repo: null,
          promptDelivery: 'submit-after-ready',
          launchPlatform: 'linux',
          launchSource: 'task_page',
          onStart: (input) =>
            startFixChecksFromDialog({
              ...input,
              targetRepoId: 'repo-1',
              item: { ...pr, type: 'issue', repoId: 'repo-1' }
            }),
          onClose: vi.fn()
        })
      : launch({
          agentOverride: 'claude',
          resolveLaunchInputs: (agent) =>
            projectSourceControlActionLaunch(recipe, agent, {
              renderedPrompt: 'Fix checks',
              settings: useAppStore.getState().settings
            })
        }))
    const startup = mocks.activateAndRevealWorktree.mock.lastCall?.[1].startup
    expect(startup?.launchToken).toEqual(expect.any(String))
    expect(startup?.freshAgentLaunch).toMatchObject({ actionAgentArgs: '--verbose' })
    expect(startup?.freshAgentLaunch).not.toHaveProperty('agentArgs')
    const call = vi.fn(async () => ({
      ok: true as const,
      id: 'create',
      result: {
        terminal: { handle: 'fix-checks', worktreeId: 'repo-1::/repo/worktree', title: null }
      }
    }))
    const subscribe = vi.fn(async (_args, callbacks) => {
      queueMicrotask(() => callbacks.onResponse({ ok: true, result: { type: 'ready' } }))
      return { unsubscribe: vi.fn(), sendBinary: vi.fn() }
    })
    Object.assign(window.api, { runtimeEnvironments: { call, subscribe } })
    const transport = createRemoteRuntimePtyTransport('host', {
      worktreeId: 'repo-1::/repo/worktree',
      ...startup,
      launchToken: undefined,
      tabId: 'checks-tab',
      leafId: '11111111-1111-4111-8111-111111111111'
    })
    await transport.connect({ url: '', callbacks: {} })
    expect(call).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'terminal.createAgentSession',
        params: expect.objectContaining({
          agent: 'claude',
          agentArgs: '--dangerously-skip-permissions --verbose'
        })
      })
    )
    transport.disconnect()
  }
)

it.each(['agent', 'blank', 'invalid-args'] as const)(
  'settles a paired %s work-item launch with no immediate renderer tab',
  async (selection) => {
    mocks.store.repos = [{ id: 'repo-1', path: '/repo', executionHostId: 'runtime:host' }]
    mocks.store.runtimeDetectedAgents = { host: ['codex'] }
    mocks.store.runtimeStatusByEnvironmentId = new Map([
      ['host', { status: { runtimeId: 'rt', hostPlatform: 'linux' } }]
    ])
    mocks.store.ensureRuntimeDetectedAgents = vi.fn(async () => ['codex'])
    mocks.store.settings = {
      defaultTuiAgent: 'codex',
      disabledTuiAgents: [],
      nativeChatProviders: {}
    }
    hostMocks.callRuntimeRpc.mockImplementation(async (_target, method) =>
      method === 'settings.getAgentLaunch'
        ? {
            settings: {
              defaultTuiAgent: 'codex',
              disabledTuiAgents: [],
              agentCmdOverrides: {},
              agentDefaultArgs: {}
            }
          }
        : { agents: ['codex'] }
    )
    vi.spyOn(inventory, 'loadProjectLaunchContext').mockResolvedValue(undefined)
    mocks.activateAndRevealWorktree.mockReturnValue({
      primaryTabId: null,
      ...(selection === 'agent' ? { startupAccepted: true } : {})
    })
    const onFailureNotified = vi.fn()
    const completed = await launch({
      onFailureNotified,
      agentLaunchPreferences: {
        defaultTuiAgent: selection === 'blank' ? 'blank' : 'codex',
        disabledTuiAgents: []
      },
      ...(selection === 'invalid-args' ? { resolveAgentArgs: () => "--model '" } : {})
    })
    expect(mocks.createWorktree).toHaveBeenCalledOnce()
    if (selection === 'invalid-args') {
      expect(completed).toBe(false)
      expect(mocks.toastError.mock.calls).toEqual([['Could not build the agent launch command.']])
      expect(onFailureNotified).toHaveBeenCalledOnce()
    } else {
      expect(completed).toBe(true)
      expect(mocks.toastError).not.toHaveBeenCalled()
      expect(onFailureNotified).not.toHaveBeenCalled()
    }
    if (selection !== 'agent') {
      expect(mocks.activateAndRevealWorktree.mock.lastCall?.[1]).not.toHaveProperty('startup')
    }
  }
)
