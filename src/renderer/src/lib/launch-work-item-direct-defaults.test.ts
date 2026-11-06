import { EVERY_AGENT_CHAT } from '../../../shared/native-chat/every-agent-chat.test-fixture'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mocks, hostMocks } from './launch-work-item-direct-test-fixture'

import { resolveProjectExecutionRuntime } from '../../../shared/project-execution-runtime'

import * as inventory from './agent-detection-target-inventory'
import * as localCapabilities from '@/runtime/local-runtime-capabilities'
import { resetHostStructuredAgentsForTests } from '@/runtime/host-structured-agents'
import { clearHostAgentMenuSettingsForTests } from '@/runtime/agent-launch-settings/host-agent-launch-preferences-resource'

import { makeWorktree } from '@/store/slices/worktrees-slice-test-fixtures'
import { useAppStore } from '@/store'

import { RUNTIME_CAPABILITIES } from '../../../shared/protocol-version'
import { projectSourceControlActionLaunch } from '../../../shared/source-control/ai/recipes/source-control-action-launch-preferences'
import { tokenizeStartupCommand } from '../../../shared/agent-launch/startup/tui-agent-startup-shell'
import { runSourceControlAgentActionStart } from '../components/right-sidebar/source-control/ai/runSourceControlAgentActionStart'
import { startFixChecksFromDialog } from '../components/pull-request-page/checks/fix-launch'
import { sourceControlActionRecipeEntry } from '../../../shared/source-control/ai/recipes/source-control-action-selection'
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
        settings: useAppStore.getState().settings,
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
