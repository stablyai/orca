// @vitest-environment happy-dom
import { beforeEach, expect, it, vi } from 'vitest'
import { getDefaultSettings } from '../../../shared/constants'
import { WORKTREE_CREATE_AGENT_OPTIONS_RUNTIME_CAPABILITY as CREATE_OPTIONS } from '../../../shared/worktree-runtime-capabilities'
import type { AgentPickerEntry } from '../../../shared/agent-launch/picker/agent-launch-picker'
import { quickWorkspacePickerInputs } from './quick-workspace-agent-selection'
import { createWorktreeOnRuntimeHost } from '@/store/slices/worktrees/create/host-planned-agent-launch'
import type { WorktreeCreateRequest } from '@/store/slices/worktrees/create/worktree-create-payload'
import { prepareQuickComposerStartup } from '@/hooks/composer-state/quick-startup-plan'
import { worktreeCreationAgentLaunchOptions } from '@/lib/workspace/creation/worktree-creation-host-agent-launch'
import type { WorktreeCreationRequest } from '@/lib/workspace/creation/pending-worktree-creation'
import { RuntimeRpcCallError } from '@/runtime/runtime-rpc-result'

const mocks = vi.hoisted(() => ({ call: vi.fn(), supports: vi.fn(), cached: vi.fn() }))
vi.mock('@/runtime/runtime-rpc-client', () => ({
  callRuntimeRpc: mocks.call,
  runtimeEnvironmentSupportsCapability: mocks.supports,
  readCachedRuntimeEnvironmentCapability: mocks.cached
}))
vi.mock('@/store', () => ({ useAppStore: { getState: () => ({}) } }))
vi.mock('@/runtime/agent-launch-settings/use-host-agent-launch-preferences', () => ({
  ensureAgentLaunchPreferences: async () => ({
    agentLaunchChoices: { claude: { model: 'sonnet', options: { effort: 'low' } } }
  })
}))

const entry: AgentPickerEntry = {
  agent: 'claude',
  label: 'Claude',
  rows: [],
  surfaces: ['terminal'],
  defaultSurface: 'terminal',
  terminal: {},
  structured: {},
  arguments: '--add-dir /host/shared',
  catalog: { origin: 'unknown' }
}
const attempt = { name: 'test' }
function creationRequest(
  quick: Awaited<ReturnType<typeof prepareQuickComposerStartup>>,
  launchInputs?: WorktreeCreationRequest['launchInputs']
): WorktreeCreationRequest {
  return {
    repoId: 'repo',
    name: 'test',
    setupDecision: 'skip',
    agent: 'claude',
    pendingFirstAgentMessageRename: false,
    note: '',
    quickPrompt: quick.prompt,
    launchDraftPrompt: quick.draftPrompt ?? undefined,
    launchInputs,
    quickTelemetry: quick.telemetry,
    ...quick
  }
}
const input = {
  agent: 'claude' as const,
  repoId: 'repo',
  executionHostId: 'runtime:host' as const,
  linkedWorkItem: null,
  note: '',
  settings: {
    ...getDefaultSettings('/tmp'),
    agentCmdOverrides: { claude: '/desktop/claude' },
    agentDefaultEnv: { claude: { DESKTOP_ONLY: 'yes' } }
  },
  launchHost: { kind: 'known' as const, hostKind: 'runtime' as const, platform: 'linux' as const },
  shell: 'posix' as const,
  isRemote: true,
  telemetrySource: undefined
}
beforeEach(() => {
  vi.clearAllMocks()
  mocks.call.mockResolvedValue({ worktree: { id: 'created' } })
  mocks.supports.mockImplementation(
    async (_host: string, capability: string) => capability === CREATE_OPTIONS
  )
  mocks.cached.mockReturnValue(true)
})

it('sends only fresh inputs to a capable host, including authored empty Arguments', async () => {
  const projection = quickWorkspacePickerInputs(
    {
      agent: 'claude',
      surface: 'terminal',
      choices: { model: 'opus', options: { effort: 'high' }, permissionMode: 'full-access' }
    },
    entry,
    'runtime:host'
  )
  const quick = await prepareQuickComposerStartup({
    ...input,
    ...projection,
    settings: { ...input.settings, agentDefaultArgs: { claude: "'unterminated" } }
  })
  expect(quick.startupPlan).toBeNull()
  expect(quick.creationStartup?.sessionOptions).toEqual({
    model: 'opus',
    effort: 'high',
    permissionMode: 'full-access'
  })
  const request: WorktreeCreateRequest = {
    repoId: 'repo',
    name: 'test',
    setupDecision: 'skip',
    createdWithAgent: 'claude',
    options: {
      creationAgentLaunch: { agent: 'claude', inputs: projection.launchInputs },
      legacyStartup: () => {
        throw new Error('desktop parser reached')
      }
    }
  }
  const result = await createWorktreeOnRuntimeHost('host', request, attempt, {})
  expect(result.hostPlannedStartup).toBeUndefined()
  expect(mocks.call.mock.calls[0]?.[2]).toEqual({
    repo: 'repo',
    name: 'test',
    baseBranch: undefined,
    setupDecision: 'skip',
    sparseCheckout: undefined,
    createdWithAgent: 'claude',
    startupAgent: 'claude',
    startupSessionOptions: { model: 'opus', effort: 'high', permissionMode: 'full-access' },
    startupLaunchPreferences: { model: 'opus', effort: 'high', mode: 'full-access' },
    activate: true
  })
  await createWorktreeOnRuntimeHost(
    'host',
    {
      ...request,
      options: {
        creationAgentLaunch: {
          agent: 'claude',
          inputs: { ...projection.launchInputs, agentArgs: '' }
        }
      }
    },
    attempt,
    {}
  )
  expect(mocks.call.mock.calls[1]?.[2]).toMatchObject({ startupAgentArgs: '' })
})

it('keeps the legacy modal Arguments projection on a host without the new capability', async () => {
  mocks.cached.mockReturnValue(false)
  mocks.supports.mockImplementation(
    async (_host: string, capability: string) => capability === 'agent.launch.v2'
  )
  const projection = quickWorkspacePickerInputs(
    { agent: 'claude', surface: 'terminal', choices: { model: 'opus' } },
    entry,
    'runtime:host'
  )
  const quick = await prepareQuickComposerStartup({ ...input, ...projection })
  expect(projection.launchInputs?.agentArgs).toBeUndefined()
  expect(projection.legacyLaunchInputs?.agentArgs).toBe('--add-dir /host/shared')
  await createWorktreeOnRuntimeHost(
    'host',
    {
      repoId: 'repo',
      name: 'test',
      setupDecision: 'skip',
      startup: quick.backendStartup,
      options: worktreeCreationAgentLaunchOptions(creationRequest(quick, projection.launchInputs))
    },
    attempt,
    {}
  )
  expect(mocks.call.mock.calls[0]?.[2]).toEqual({
    repo: 'repo',
    name: 'test',
    baseBranch: undefined,
    setupDecision: 'skip',
    sparseCheckout: undefined,
    startupCommand: "/desktop/claude '--add-dir' '/host/shared' '--model' 'opus'",
    startupEnv: { DESKTOP_ONLY: 'yes' },
    startupLaunchConfig: expect.objectContaining({
      agentArgs: expect.stringContaining('/host/shared')
    }),
    activate: true
  })
})

it('uses the draft host path without startupAgent and retries unknown agents with the legacy projection', async () => {
  const quick = await prepareQuickComposerStartup({
    ...input,
    note: 'ship it',
    linkedWorkItem: {
      provider: 'github',
      number: 42,
      title: 'fix',
      url: 'https://example.com/42'
    },
    launchInputs: { agentArgs: null, sessionOptions: { model: 'opus' } },
    legacyLaunchInputs: { agentArgs: '--add-dir /host/shared', sessionOptions: { model: 'opus' } }
  })
  const request: WorktreeCreateRequest = {
    repoId: 'repo',
    name: 'test',
    createdWithAgent: 'claude',
    options: worktreeCreationAgentLaunchOptions(
      creationRequest(quick, { agentArgs: null, sessionOptions: { model: 'opus' } })
    )
  }
  await createWorktreeOnRuntimeHost('host', request, attempt, {})
  expect(mocks.call.mock.calls[0]?.[2]).toMatchObject({
    createdWithAgent: 'claude',
    startupDraft: expect.stringContaining('ship it'),
    startupAgentArgs: null,
    startupSessionOptions: { model: 'opus' }
  })
  expect(mocks.call.mock.calls[0]?.[2]).not.toHaveProperty('startupAgent')
  mocks.call.mockRejectedValueOnce(
    new RuntimeRpcCallError({
      id: 'test',
      ok: false,
      error: { code: 'invalid_argument', message: 'Unknown TUI agent' }
    })
  )
  await createWorktreeOnRuntimeHost('host', request, attempt, {})
  expect(mocks.call.mock.calls[2]?.[2]).toMatchObject({
    startupCommand: expect.stringContaining("'/host/shared'")
  })
  expect(mocks.call.mock.calls[2]?.[2]).not.toHaveProperty('startupDraft')
})

it.each([false, null])(
  'validates desktop Arguments at submit while cached capability is %s',
  async (cached) => {
    mocks.cached.mockReturnValue(cached)
    await expect(
      prepareQuickComposerStartup({
        ...input,
        launchInputs: { sessionOptions: { model: 'opus' } },
        legacyLaunchInputs: { agentArgs: "'unterminated" }
      })
    ).rejects.toThrow()
  }
)

it('seeds the eager legacy plan after command flags override the host default', async () => {
  mocks.cached.mockReturnValue(false)
  const quick = await prepareQuickComposerStartup({
    ...input,
    settings: { ...input.settings, agentCmdOverrides: { claude: '/desktop/claude --model haiku' } }
  })
  expect(quick.startupPlan?.launchCommand).toContain('haiku')
  expect(quick.startupPlan?.launchCommand).not.toContain('sonnet')
  expect(quick.creationStartup?.sessionOptions?.model).toBeUndefined()
})

it('preserves the untouched draft payload shape and prepares the current held message', async () => {
  const quick = await prepareQuickComposerStartup({
    ...input,
    linkedWorkItem: {
      provider: 'github',
      number: 42,
      title: 'fix',
      url: 'https://example.com/42'
    }
  })
  const options = worktreeCreationAgentLaunchOptions(creationRequest(quick))
  await createWorktreeOnRuntimeHost(
    'host',
    { repoId: 'repo', name: 'test', createdWithAgent: 'claude', options },
    attempt,
    {}
  )
  const payload = mocks.call.mock.calls[0]?.[2]
  expect(payload).toHaveProperty('startupDraft', 'https://example.com/42')
  expect(payload).not.toHaveProperty('activate')
  expect(payload).not.toHaveProperty('launchSource')
  const held = quick.creationStartup?.legacy('held message', 'draft')
  expect(held?.startupPlan?.launchCommand).toContain("'held message'")
  expect(held?.startupPlan?.launchCommand).not.toContain('https://example.com/42')
})

it('keeps main legacy Aider command bytes on a host without creation options', async () => {
  mocks.cached.mockReturnValue(false)
  mocks.supports.mockResolvedValue(false)
  const quick = await prepareQuickComposerStartup({
    ...input,
    agent: 'aider',
    note: 'fix it',
    linkedWorkItem: { provider: 'linear', number: 0, url: '' },
    launchInputs: { agentArgs: '' }
  })
  await createWorktreeOnRuntimeHost(
    'host',
    {
      repoId: 'repo',
      name: 'test',
      setupDecision: 'skip',
      startup: quick.backendStartup,
      options: worktreeCreationAgentLaunchOptions({
        ...creationRequest(quick, { agentArgs: '' }),
        agent: 'aider'
      })
    },
    attempt,
    {}
  )
  expect(mocks.call.mock.calls[0]?.[2]).toEqual({
    repo: 'repo',
    name: 'test',
    baseBranch: undefined,
    setupDecision: 'skip',
    sparseCheckout: undefined
  })
  expect(quick.startupPlan?.launchCommand).toBe('aider')
  expect(quick.startupPlan?.followupPrompt).toBe('fix it')
})
