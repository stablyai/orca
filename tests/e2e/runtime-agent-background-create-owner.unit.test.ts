import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from '../../src/main/runtime/orca-runtime'
import { resolveAgentStartupPlanInputs } from '../../src/shared/agent-startup-plan-inputs'
import { buildAgentStartupPlan } from '../../src/shared/tui-agent-startup'
import { createRuntimeAgentBackgroundTerminal } from '../../src/renderer/src/lib/runtime-agent-background-create'
import { createCompatibleRuntimeStatusResponseIfNeeded } from '@/runtime/runtime-compatibility-test-fixture'
import { stubRuntimeEnvironmentBridge } from '@/runtime/runtime-environment-bridge-fixture'
import { clearRuntimeCompatibilityCacheForTests } from '@/runtime/runtime-rpc-client'

const runtimeCall = vi.fn()
beforeEach(() => {
  runtimeCall.mockReset()
  clearRuntimeCompatibilityCacheForTests()
  stubRuntimeEnvironmentBridge({
    call: (request: { method: string }) =>
      createCompatibleRuntimeStatusResponseIfNeeded(request) ?? runtimeCall(request)
  })
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('background creation owning-host boundary', () => {
  it.each([undefined, { model: 'picked', effort: 'low' }])(
    'keeps capable-host defaults separate from requested choices (%j) through actual host creation',
    async (sessionOptions) => {
      const runtime = new OrcaRuntimeService(
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: this creation contract only reads the settings store.
        {
          getSettings: () => ({
            agentPermissionDefault: 'own',
            agentLaunchChoices: { claude: { model: 'opus', options: { effort: 'high' } } }
          })
        } as never
      )
      Object.assign(runtime, {
        resolveTerminalWorkspaceLaunchScope: vi.fn(async () => ({
          id: 'wt-1',
          path: '/host/worktree',
          connectionId: null,
          repo: null,
          folderWorkspace: null
        }))
      })
      const compile = vi.spyOn(runtime, 'planAgentPaneLaunch')
      const spawn = vi
        .spyOn(runtime, 'createTerminal')
        .mockImplementation(async (_worktree, options) => {
          await runtime.planAgentPaneLaunch('wt-1', options ?? {})
          return { handle: 'host-created', worktreeId: 'wt-1', title: null }
        })
      runtimeCall.mockImplementation(async (request) => {
        if (request.method !== 'terminal.createAgentSession') {
          throw new Error(`Unexpected dispatch ${request.method}`)
        }
        return { ok: true, result: await runtime.createAgentSession(request.params) }
      })
      const clientPlan = buildAgentStartupPlan({
        ...resolveAgentStartupPlanInputs({
          agent: 'claude',
          platform: 'linux',
          isRemote: true,
          shell: 'posix',
          sessionOptions,
          settings: {
            agentPermissionDefault: 'own',
            agentLaunchChoices: { claude: { model: 'sonnet', options: { effort: 'medium' } } }
          }
        }),
        prompt: 'Fix checks'
      })
      if (!clientPlan) {
        throw new Error('Expected startup plan')
      }
      const result = await createRuntimeAgentBackgroundTerminal({
        environmentId: 'env-1',
        worktreeId: 'wt-1',
        tabId: 'reserved-tab',
        leafId: 'reserved-leaf',
        agent: 'claude',
        prompt: 'Fix checks',
        sessionOptions,
        legacy: {
          command: clientPlan.launchCommand,
          env: {},
          sessionOptions: clientPlan.sessionOptions,
          launchConfig: clientPlan.launchConfig,
          launchToken: 'reserved-token'
        }
      })
      expect(result.terminal.handle).toBe('host-created')
      expect(spawn).toHaveBeenCalledTimes(1)
      const applied = await compile.mock.results[0].value
      expect(applied?.command).toContain(sessionOptions ? "'picked'" : "'opus'")
      expect(applied?.command).toContain(sessionOptions ? "'low'" : "'high'")
      expect(applied?.command).not.toContain('sonnet')
      expect(applied?.launchConfig?.agentArgs).not.toContain('opus')
      expect(applied?.launchConfig?.agentArgs).not.toContain('picked')
      expect(runtimeCall).toHaveBeenCalledTimes(1)
    }
  )
})
