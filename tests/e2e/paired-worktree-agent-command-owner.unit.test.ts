import { WorktreeCreate } from '../../src/shared/rpc-contract/worktree-create-params'
import { buildManagedWorktreeCreateArgs } from '../../src/main/runtime/rpc/methods/worktree-create-args'
import { resolveManagedWorktreeCreateStartup } from '../../src/main/runtime/workspaces/managed-worktree-create-startup'
import { buildWorktreeStartupForAgent } from '../../src/main/runtime/runtime-worktree-agent-startup'
import { getDefaultSettings } from '../../src/shared/constants'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createCompatibleRuntimeStatusResponse,
  type RuntimeEnvironmentCallRequest
} from '../../src/renderer/src/runtime/runtime-compatibility-test-fixture'
import {
  TEST_REPO,
  makeWorktree
} from '../../src/renderer/src/store/slices/worktrees-slice-test-fixtures'
import {
  createTestStore,
  resetRemoteRuntimeMocks,
  resetWorktreeSliceModuleMemory,
  runtimeEnvironmentCall,
  runtimeEnvironmentTransportCall
} from '../../src/renderer/src/store/slices/worktrees-slice-test-harness'

vi.mock('sonner', () => ({
  toast: { warning: vi.fn(), info: vi.fn(), success: vi.fn(), error: vi.fn(), dismiss: vi.fn() }
}))

beforeEach(() => {
  resetWorktreeSliceModuleMemory()
  vi.clearAllMocks()
  resetRemoteRuntimeMocks()
})

describe('paired workspace agent startup ownership', () => {
  it.each(['modern', 'prompt', 'older', 'probe-failure', 'predates-agent', 'custom'] as const)(
    'preserves launch command ownership for %s paired creation',
    async (scenario) => {
      const supported = scenario === 'modern' || scenario === 'prompt'
      const status = createCompatibleRuntimeStatusResponse('runtime-remote')
      if (status.ok && scenario === 'older') {
        status.result.capabilities = status.result.capabilities?.filter(
          (capability) => capability !== 'agent.launch.v2'
        )
      }
      let failedProbe = false
      runtimeEnvironmentTransportCall.mockImplementation((args: RuntimeEnvironmentCallRequest) => {
        if (args.method !== 'status.get') {
          return runtimeEnvironmentCall(args)
        }
        if (scenario === 'probe-failure' && !failedProbe) {
          failedProbe = true
          throw new Error('temporary status read failure')
        }
        return status
      })
      const hostSettings = {
        ...getDefaultSettings('/host'),
        agentCmdOverrides: { claude: '/host/claude-wrapper' },
        agentDefaultArgs: { claude: '--host-only' },
        agentDefaultEnv: { claude: { LAUNCH_OWNER: 'host' } }
      }
      const store = createTestStore()
      store.setState({ repos: [{ ...TEST_REPO, executionHostId: 'runtime:env-1' }] })
      let launchedCommand = ''
      let launchedEnv: Record<string, string> | undefined
      let delivered = ''
      runtimeEnvironmentCall.mockImplementation(async (call) => {
        expect(call.method).toBe('worktree.create')
        if (scenario === 'predates-agent' && call.params && 'startupAgent' in call.params) {
          // What a host older than the agent answers while validating its name.
          return {
            id: 'host-create',
            ok: false,
            error: { code: 'invalid_argument', message: 'Unknown TUI agent' },
            _meta: { runtimeId: 'runtime-remote' }
          }
        }
        const params = WorktreeCreate.parse(call.params)
        const args = buildManagedWorktreeCreateArgs(params, {})
        const resolved = await resolveManagedWorktreeCreateStartup(args, [], {
          agent: (agent, prompt) =>
            buildWorktreeStartupForAgent({
              agent,
              prompt,
              repo: TEST_REPO,
              settings: hostSettings,
              getLaunchRuntime: () => ({
                platform: 'linux',
                shell: 'posix',
                launchRuntime: {
                  platform: 'linux',
                  pty: { shellOverride: undefined, terminalWindowsWslDistro: null }
                }
              }),
              toSessionOptions: () => undefined
            }),
          draft: async () => null
        })
        delivered = [resolved.effectiveStartup?.command, resolved.effectiveStartupFollowup?.prompt]
          .filter(Boolean)
          .join('\n')
        launchedCommand = resolved.effectiveStartup?.command ?? ''
        launchedEnv = resolved.effectiveStartup?.env
        return {
          id: 'host-create',
          ok: true,
          result: {
            worktree: makeWorktree({ id: 'repo1::/path/host-agent', repoId: 'repo1' }),
            startupTerminal: { spawned: true, tabId: 'host-tab' }
          },
          _meta: { runtimeId: 'runtime-remote' }
        }
      })
      const createWorktree = store.getState().createWorktree
      const args: Parameters<typeof createWorktree> = ['repo1', 'host-agent']
      args[10] = 'claude'
      args[16] = {
        command: '/client/claude --client-only',
        env: { LAUNCH_OWNER: 'client' },
        launchAgent: 'claude'
      }
      args[25] = {
        ...(scenario === 'custom'
          ? {}
          : {
              hostAgentLaunch: {
                agent: 'claude' as const,
                ...(scenario === 'prompt' ? { prompt: 'prompt-text' } : {})
              }
            }),
        executionHostId: 'runtime:env-1'
      }

      await createWorktree(...args)

      expect(launchedCommand).toContain(supported ? '/host/claude-wrapper' : '/client/claude')
      expect(launchedCommand).toContain(supported ? '--host-only' : '--client-only')
      expect(launchedEnv?.LAUNCH_OWNER).toBe(supported ? 'host' : 'client')
      if (scenario === 'prompt') {
        // Exactly once, through whichever channel the host's planner picked.
        expect(delivered.split('prompt-text')).toHaveLength(2)
      }
      expect(runtimeEnvironmentCall).toHaveBeenCalledTimes(scenario === 'predates-agent' ? 2 : 1)
    }
  )
})
