// @vitest-environment happy-dom
import { beforeEach, expect, it, vi } from 'vitest'
import { getDefaultSettings } from '../../../shared/constants'
import { WORKTREE_CREATE_AGENT_OPTIONS_RUNTIME_CAPABILITY as CREATE_OPTIONS } from '../../../shared/worktree-runtime-capabilities'
import { prepareQuickComposerStartup } from '@/hooks/composer-state/quick-startup-plan'

const mocks = vi.hoisted(() => ({ call: vi.fn(), supports: vi.fn(), cached: vi.fn() }))
vi.mock('@/runtime/rpc/calls/runtime-rpc-call', () => ({ callRuntimeRpc: mocks.call }))
vi.mock('@/runtime/rpc/compatibility/runtime-capability-proof', () => ({
  runtimeEnvironmentSupportsCapability: mocks.supports
}))
vi.mock('@/runtime/rpc/compatibility/runtime-compatibility-cache', () => ({
  readCachedRuntimeEnvironmentCapability: mocks.cached
}))
vi.mock('@/store', () => ({ useAppStore: { getState: () => ({}) } }))
vi.mock('@/runtime/agent-launch-settings/use-host-agent-launch-preferences', () => ({
  ensureAgentLaunchPreferences: async () => ({
    agentLaunchChoices: { claude: { model: 'sonnet', options: { effort: 'low' } } }
  })
}))
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
