// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest'
import type { WorktreeCreationRequest } from '@/lib/workspace/creation/pending-worktree-creation'
import { buildWorktreeCreationStartupOpt } from '@/lib/workspace/creation/worktree-creation-flow-startup'
import { ensureWebRuntimeWorktreeTerminalAfterWake } from '@/lib/web-runtime-worktree-terminal-after-wake'
import { resetWebRuntimeWakeTerminalRespawnForTests } from '@/runtime/hosted-terminals/restoration/web-runtime-wake-terminal-respawn'

const mocks = vi.hoisted(
  (): {
    launch: ReturnType<typeof vi.fn>
    seedOptions: ReturnType<typeof vi.fn>
    seedDraft: ReturnType<typeof vi.fn>
    agent: 'claude' | 'codex'
  } => ({
    launch: vi.fn(),
    seedOptions: vi.fn(),
    seedDraft: vi.fn(),
    agent: 'claude'
  })
)
vi.mock('@/lib/agent-session/launch/new-tab/launch-agent-web-host-tab', () => ({
  launchAgentInWebHostTab: mocks.launch
}))
vi.mock('@/lib/workspace/ownership/worktree-runtime-owner', () => ({
  runtimeEnvironmentIdOrLocalUnlessTwin: () => 'host'
}))
vi.mock('@/runtime/web-session-tabs-sync/identity/web-runtime-session-environment', () => ({
  isWebRuntimeSessionActive: () => true
}))
vi.mock('../../../shared/native-chat/input/native-chat-session-option-cache', () => ({
  seedNativeChatAppliedSessionOptions: mocks.seedOptions
}))
vi.mock('@/lib/agent-session/launch/prompt/agent-launch-prompt-delivery', () => ({
  seedNativeChatLaunchDraftForAgentTab: mocks.seedDraft
}))
vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => ({
      getKnownWorktreeById: () => ({ id: 'wt' }),
      tabsByWorktree: { wt: [{ id: 'agent-tab', launchAgent: mocks.agent }] },
      ptyIdsByTabId: {}
    })
  }
}))

const request: WorktreeCreationRequest = {
  repoId: 'repo',
  name: 'created',
  agent: 'claude',
  setupDecision: 'skip',
  pendingFirstAgentMessageRename: false,
  note: '',
  startupPlan: null,
  quickPrompt: '',
  quickTelemetry: null,
  launchDraftPrompt: 'ship it',
  launchInputs: { agentArgs: '', sessionOptions: { model: 'opus', effort: 'high' } },
  creationStartup: {
    legacy: () => {
      throw new Error('desktop parser reached')
    },
    sessionOptions: { model: 'opus', effort: 'high' }
  }
}
afterEach(() => {
  vi.clearAllMocks()
  resetWebRuntimeWakeTerminalRespawnForTests()
})

it('retains a null-plan recovery payload and serializes concurrent after-wake attempts', async () => {
  const pending = Promise.withResolvers<{ outcome: { status: 'created' } }>()
  mocks.launch.mockReturnValue(pending.promise)
  const startup = buildWorktreeCreationStartupOpt(request, false)
  expect(startup).toMatchObject({
    launchAgent: 'claude',
    launchToken: expect.any(String),
    freshAgentLaunch: {
      agentArgs: '',
      sessionOptions: { model: 'opus', effort: 'high' },
      prompt: 'ship it',
      promptDelivery: 'draft'
    }
  })
  ensureWebRuntimeWorktreeTerminalAfterWake('wt', { startup, agent: 'claude', activate: false })
  ensureWebRuntimeWorktreeTerminalAfterWake('wt', { startup, agent: 'claude', activate: false })
  expect(mocks.launch).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({
      agentArgs: '',
      sessionOptions: { model: 'opus', effort: 'high' },
      prompt: 'ship it',
      promptDelivery: 'draft',
      environmentId: 'host',
      activate: false,
      selectWorktree: false
    })
  )
  pending.resolve({ outcome: { status: 'created' } })
  await pending.promise
})
