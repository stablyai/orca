import { expect, it, vi } from 'vitest'
import type { CreateWebRuntimeSessionTerminalOnHostArgs } from '@/runtime/hosted-terminals/creation/terminal-create-contracts'

const mocks = vi.hoisted((): { launch: CreateWebRuntimeSessionTerminalOnHostArgs | null } => ({
  launch: null
}))

vi.mock('@/store/index', () => ({
  useAppStore: { getState: () => ({ settings: {}, runtimeStatusByEnvironmentId: new Map() }) }
}))
vi.mock('@/runtime/hosted-terminals/creation/agent-launch/agent-session-create-request', () => ({
  agentSessionCreateCapabilities: async () => ({ capable: false, complete: false })
}))
vi.mock('../routing/paired-agent-launch-inputs', () => ({
  pairedAgentLaunchInputs: async () => ({ preparedAgentCommand: true })
}))
vi.mock('@/runtime/agent-launch-settings/agent-launch-settings-transport', () => ({
  readHostAgentStartupSettings: async () => {
    throw new Error('settings.get timed out')
  }
}))
vi.mock('@/runtime/agent-launch-settings/use-host-agent-launch-preferences', () => ({
  ensureAgentLaunchPreferences: async () => ({ agentLaunchChoices: undefined })
}))
vi.mock('@/runtime/hosted-terminals/creation/web-runtime-terminal-create-operation', () => ({
  createWebRuntimeSessionTerminalResult: async (
    launch: CreateWebRuntimeSessionTerminalOnHostArgs
  ) => {
    mocks.launch = launch
    return { outcome: { status: 'failed', message: '' } }
  }
}))
vi.mock('sonner', () => ({ toast: { error: vi.fn() } }))

const { launchAgentInWebHostTab } = await import('./launch-agent-web-host-tab')

it('refuses a paired-host draft launch instead of using this desktop settings when host settings are unreadable', async () => {
  await launchAgentInWebHostTab({
    agent: 'claude',
    worktreeId: 'wt-1',
    environmentId: 'env-1',
    prompt: 'Continue this work',
    promptDelivery: 'draft',
    buildStartup: () => ({
      startupPlan: {
        agent: 'claude',
        launchCommand: "claude '--dangerously-skip-permissions'",
        expectedProcess: 'claude',
        followupPrompt: null,
        launchConfig: {
          agentCommand: "claude '--dangerously-skip-permissions'",
          agentArgs: '--dangerously-skip-permissions',
          agentEnv: {}
        }
      },
      pasteDraftAfterLaunch: null,
      submitPastedPrompt: false
    })
  })

  await expect(mocks.launch?.legacyAgentLaunch?.()).rejects.toThrow("Couldn't open a terminal for")
})
