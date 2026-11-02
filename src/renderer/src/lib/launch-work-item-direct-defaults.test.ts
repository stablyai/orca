import { EVERY_AGENT_CHAT } from '../../../shared/native-chat/every-agent-chat.test-fixture'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mocks, hostMocks } from './launch-work-item-direct-test-fixture'
import { resolveProjectExecutionRuntime } from '../../../shared/project-execution-runtime'
import * as inventory from './agent-detection-target-inventory'
import * as localCapabilities from '@/runtime/local-runtime-capabilities'
import { resetHostStructuredAgentsForTests } from '@/runtime/host-structured-agents'
import { clearHostAgentMenuSettingsForTests } from '@/components/settings/use-host-agent-launch-preferences'
import { useAppStore } from '@/store'
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
