import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { TuiAgent } from '../../../../shared/agent-launch/catalog/tui-agent'
import { AgentLaunchChoiceCancelled } from '@/lib/host-chat-program-acquisition'
import {
  directCreateDetectionTarget,
  resolveDirectCreateAgent
} from './folder-workspace-default-agent'

const mocks = vi.hoisted(() => ({
  ensureAgentLaunchPreferences: vi.fn(),
  acquireAgentLaunchChoices: vi.fn(),
  ensureDetectedAgentsForTarget: vi.fn(),
  awaitStructuredRouteHostAnswer: vi.fn(),
  agentChoiceMayOpenAsChat: vi.fn(),
  loadProjectLaunchContext: vi.fn(),
  revision: { current: 1 as number | undefined }
}))

vi.mock('@/store', () => ({ useAppStore: { getState: () => ({ settings: {} }) } }))
vi.mock('@/runtime/agent-launch-settings/use-host-agent-launch-preferences', () => ({
  ensureAgentLaunchPreferences: mocks.ensureAgentLaunchPreferences
}))
vi.mock('@/lib/host-chat-program-acquisition', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  acquireAgentLaunchChoices: mocks.acquireAgentLaunchChoices
}))
vi.mock('@/lib/agent-detection-target-inventory', () => ({
  ensureDetectedAgentsForTarget: mocks.ensureDetectedAgentsForTarget,
  loadProjectLaunchContext: mocks.loadProjectLaunchContext,
  loadDetectedAgentsForWorktree: vi.fn()
}))
vi.mock('@/runtime/runtime-environment-revision', () => ({
  getRuntimeEnvironmentRevision: () => mocks.revision.current
}))
vi.mock('@/lib/agent-session-launch-plan', () => ({
  awaitStructuredRouteHostAnswer: mocks.awaitStructuredRouteHostAnswer
}))
vi.mock('@/lib/host-chat-program', () => ({
  agentChoiceMayOpenAsChat: mocks.agentChoiceMayOpenAsChat
}))

const workspace = { kind: 'folder', executionHostId: 'local' } as const
const detectLocal = () => mocks.ensureDetectedAgentsForTarget({}, { kind: 'local' })

function hostAnswers(detected: TuiAgent[] | null): void {
  mocks.acquireAgentLaunchChoices.mockImplementation(async (_workspace, detect) => {
    await detect()
    return { detected, offered: null }
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.ensureDetectedAgentsForTarget.mockResolvedValue([])
  mocks.awaitStructuredRouteHostAnswer.mockReturnValue(null)
  mocks.agentChoiceMayOpenAsChat.mockReturnValue(false)
  mocks.revision.current = 1
})

describe('resolveDirectCreateAgent', () => {
  it.each([
    {
      name: 'the saved default when the host has it',
      preferences: { defaultTuiAgent: 'codex' },
      detected: ['claude', 'codex'],
      expected: 'codex'
    },
    {
      name: 'the first detected agent for Auto',
      preferences: { defaultTuiAgent: null },
      detected: ['codex'],
      expected: 'codex'
    },
    {
      name: 'a detected fallback when the default is disabled',
      preferences: { defaultTuiAgent: 'codex', disabledTuiAgents: ['codex'] },
      detected: ['codex', 'claude'],
      expected: 'claude'
    },
    {
      name: 'no agent when nothing usable is detected',
      preferences: { defaultTuiAgent: 'codex' },
      detected: [],
      expected: null
    }
  ] as const)('picks $name', async ({ preferences, detected, expected }) => {
    mocks.ensureAgentLaunchPreferences.mockResolvedValue(preferences)
    hostAnswers([...detected])

    const result = await resolveDirectCreateAgent(workspace, detectLocal)

    expect(result).toEqual({ agent: expected, preferences })
  })

  it('opens a saved Chat default whose CLI the host has not reported', async () => {
    mocks.ensureAgentLaunchPreferences.mockResolvedValue({ defaultTuiAgent: 'codex' })
    mocks.agentChoiceMayOpenAsChat.mockImplementation((_store, agent) => agent === 'codex')
    hostAnswers(null)

    const result = await resolveDirectCreateAgent(workspace, detectLocal)

    expect(result.agent).toBe('codex')
    expect(mocks.awaitStructuredRouteHostAnswer).toHaveBeenCalledWith(
      expect.anything(),
      { agent: 'codex', workspace },
      3000
    )
  })

  it('keeps Blank without asking the host for agents', async () => {
    mocks.ensureAgentLaunchPreferences.mockResolvedValue({ defaultTuiAgent: 'blank' })

    const result = await resolveDirectCreateAgent(workspace, detectLocal)

    expect(result.agent).toBeNull()
    expect(mocks.acquireAgentLaunchChoices).not.toHaveBeenCalled()
  })

  it('asks for agents through the bounded wait', async () => {
    mocks.ensureAgentLaunchPreferences.mockResolvedValue({ defaultTuiAgent: 'claude' })
    hostAnswers(['claude'])

    await resolveDirectCreateAgent(workspace, detectLocal)

    expect(mocks.acquireAgentLaunchChoices).toHaveBeenCalledWith(
      workspace,
      detectLocal,
      undefined,
      true
    )
    expect(directCreateDetectionTarget('runtime:env-1')).toEqual({
      kind: 'runtime',
      environmentId: 'env-1'
    })
  })

  it('reads an Open as Folder project its own agents before the host default list', async () => {
    mocks.loadProjectLaunchContext.mockResolvedValue({ agents: ['codex'] })

    const agents = await detectFolderRepoAgents('notes', 'runtime:env-1')()

    expect(agents).toEqual(['codex'])
    expect(mocks.loadProjectLaunchContext).toHaveBeenCalledWith(
      { kind: 'environment', environmentId: 'env-1' },
      'notes'
    )
    expect(mocks.ensureDetectedAgentsForTarget).not.toHaveBeenCalled()
  })

  it('drops the click when the paired server is re-paired during the route wait', async () => {
    const runtimeWorkspace = { kind: 'folder', executionHostId: 'runtime:env-1' } as const
    mocks.ensureAgentLaunchPreferences.mockResolvedValue({ defaultTuiAgent: 'codex' })
    hostAnswers(['codex'])
    mocks.awaitStructuredRouteHostAnswer.mockImplementation(async () => {
      mocks.revision.current = 2
    })

    await expect(resolveDirectCreateAgent(runtimeWorkspace, detectLocal)).rejects.toBeInstanceOf(
      AgentLaunchChoiceCancelled
    )
  })

  it('drops the click when the host owner changes while resolving', async () => {
    mocks.ensureAgentLaunchPreferences.mockResolvedValue({ defaultTuiAgent: 'codex' })
    mocks.acquireAgentLaunchChoices.mockRejectedValue(new AgentLaunchChoiceCancelled('changed'))

    await expect(resolveDirectCreateAgent(workspace, detectLocal)).rejects.toBeInstanceOf(
      AgentLaunchChoiceCancelled
    )
  })
})
