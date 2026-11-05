import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CreateAgentSessionParams } from '../../src/shared/rpc-contract/agent-session-params'
import { OrcaRuntimeService } from '../../src/main/runtime/orca-runtime'
import { createRuntimeAgentBackgroundTerminal } from '../../src/renderer/src/lib/runtime-agent-background-create'
import {
  createCompatibleRuntimeStatusResponse,
  createCompatibleRuntimeStatusResponseIfNeeded
} from '@/runtime/runtime-compatibility-test-fixture'
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
  const requestedOptions: (Record<string, string> | undefined)[] = [
    undefined,
    {},
    { model: 'picked', effort: 'low' },
    { fastMode: 'true' }
  ]
  it.each(requestedOptions)(
    'keeps capable-host defaults separate from requested choices (%j) through actual host creation',
    async (sessionOptions) => {
      const runtime = new OrcaRuntimeService(
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: this creation contract only reads the settings store.
        {
          getSettings: () => ({
            agentPermissionDefault: 'ask',
            agentDefaultArgs: { claude: '--add-dir /server-tools' },
            agentDefaultEnv: { claude: { FROM_HOST: 'server' } },
            agentCmdOverrides: { claude: '/server/bin/claude' },
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
          const plan = await runtime.planAgentPaneLaunch(
            'wt-1',
            options ?? {},
            options?.sessionOptions
          )
          return {
            handle: 'host-created',
            worktreeId: 'wt-1',
            title: null,
            launchConfig: plan.launchConfig,
            launchToken: 'host-token'
          }
        })
      runtimeCall.mockImplementation(async (request) => {
        if (request.method !== 'terminal.createAgentSession') {
          throw new Error(`Unexpected dispatch ${request.method}`)
        }
        return {
          ok: true,
          result: await runtime.createAgentSession(CreateAgentSessionParams.parse(request.params))
        }
      })
      const result = await createRuntimeAgentBackgroundTerminal({
        environmentId: 'env-1',
        worktreeId: 'wt-1',
        tabId: 'reserved-tab',
        leafId: 'reserved-leaf',
        agent: 'claude',
        prompt: 'Fix checks',
        sessionOptions,
        legacy: async () => {
          throw new Error('Modern host must not compile client defaults')
        }
      })
      expect(result.terminal.handle).toBe('host-created')
      expect(spawn).toHaveBeenCalledTimes(1)
      const applied = await compile.mock.results[0].value
      expect(applied?.command).toContain(sessionOptions?.model ? "'picked'" : "'opus'")
      expect(applied?.command).toContain(sessionOptions?.effort ? "'low'" : "'high'")
      expect(applied?.command).not.toContain('sonnet')
      expect(applied?.command).toContain('/server/bin/claude')
      expect(applied?.command).toContain('/server-tools')
      expect(applied?.env).toMatchObject({ FROM_HOST: 'server' })
      if (sessionOptions?.fastMode) {
        expect(applied?.command).toContain('{"fastMode":true}')
      }
      expect(applied?.launchConfig?.agentArgs).not.toContain('opus')
      expect(applied?.launchConfig?.agentArgs).not.toContain('picked')
      expect(runtimeCall).toHaveBeenCalledTimes(1)
    }
  )
  it('reports a failed observation and uses recovered host support on the next launch', async () => {
    const status = vi
      .fn()
      .mockRejectedValueOnce(new Error('Host connection lost'))
      .mockResolvedValue(createCompatibleRuntimeStatusResponse())
    stubRuntimeEnvironmentBridge({
      call: (request: { method: string }) =>
        request.method === 'status.get' ? status() : runtimeCall(request)
    })
    runtimeCall.mockResolvedValue({ ok: true, result: { terminal: { handle: 'recovered' } } })
    const legacy = vi.fn()
    const args = {
      environmentId: 'env-1',
      worktreeId: 'wt-1',
      tabId: 'tab',
      leafId: 'leaf',
      agent: 'claude' as const,
      sessionOptions: { model: 'claude-opus-5-5[1m]' },
      legacy
    }
    await expect(createRuntimeAgentBackgroundTerminal(args)).rejects.toThrow('Host connection lost')
    expect(runtimeCall).not.toHaveBeenCalled()
    await expect(createRuntimeAgentBackgroundTerminal(args)).resolves.toMatchObject({
      terminal: { handle: 'recovered' }
    })
    expect(
      runtimeCall.mock.calls.map(([request]) => [request.method, request.params.sessionOptions])
    ).toEqual([['terminal.createAgentSession', { model: 'claude-opus-5-5[1m]' }]])
    expect(legacy).not.toHaveBeenCalled()
  })
  it('keeps a persistent status failure distinct from an unsupported host', async () => {
    const legacy = vi.fn()
    stubRuntimeEnvironmentBridge({
      call: async () => {
        throw new Error('Host offline')
      }
    })
    await expect(
      createRuntimeAgentBackgroundTerminal({
        environmentId: 'env-1',
        worktreeId: 'wt-1',
        tabId: 'tab',
        leafId: 'leaf',
        agent: 'claude',
        sessionOptions: {},
        legacy
      })
    ).rejects.toThrow('Host offline')
    expect(legacy).not.toHaveBeenCalled()
    expect(runtimeCall).not.toHaveBeenCalled()
  })
  it('does not launch a legacy duplicate after an ambiguous dispatch failure', async () => {
    const legacy = vi.fn()
    runtimeCall.mockRejectedValue(new Error('Connection lost after dispatch'))
    await expect(
      createRuntimeAgentBackgroundTerminal({
        environmentId: 'env-1',
        worktreeId: 'wt-1',
        tabId: 'tab',
        leafId: 'leaf',
        agent: 'claude',
        sessionOptions: {},
        legacy
      })
    ).rejects.toThrow('Connection lost after dispatch')
    expect(legacy).not.toHaveBeenCalled()
    const operations = runtimeCall.mock.calls.map(([request]) => request.params.clientOperationId)
    expect(operations[0]).toEqual(expect.any(String))
    expect(new Set(operations).size).toBe(1)
  })
  it.each(['method_not_found', 'agent_session_legacy_required'])(
    'never downgrades modern complete input after %s',
    async (code) => {
      const legacy = vi.fn()
      runtimeCall.mockResolvedValue({ ok: false, error: { code, message: 'No dispatch' } })
      await expect(
        createRuntimeAgentBackgroundTerminal({
          environmentId: 'env-1',
          worktreeId: 'wt-1',
          tabId: 'reserved-tab',
          leafId: 'reserved-leaf',
          agent: 'claude',
          sessionOptions: {},
          agentArgs: null,
          legacy
        })
      ).rejects.toThrow('could not apply the agent launch settings')
      expect(legacy).not.toHaveBeenCalled()
      expect(runtimeCall.mock.calls.map(([request]) => request.method)).toEqual([
        'terminal.createAgentSession'
      ])
    }
  )

  it('rejects complete input before dispatch on a host without complete launch support', async () => {
    const legacy = vi.fn()
    const status = createCompatibleRuntimeStatusResponse()
    status.result.capabilities = status.result.capabilities?.filter(
      (capability) => capability !== 'agent-session.create-options.v1'
    )
    stubRuntimeEnvironmentBridge({
      call: (request: { method: string }) =>
        request.method === 'status.get' ? status : runtimeCall(request)
    })
    await expect(
      createRuntimeAgentBackgroundTerminal({
        environmentId: 'env-1',
        worktreeId: 'wt-1',
        tabId: 'reserved-tab',
        leafId: 'reserved-leaf',
        agent: 'claude',
        sessionOptions: {},
        legacy
      })
    ).rejects.toThrow('Update Orca on this host')
    expect(legacy).not.toHaveBeenCalled()
    expect(runtimeCall).not.toHaveBeenCalled()
  })
  it('keeps the definite no-dispatch legacy fallback when no modern options are requested', async () => {
    const legacy = vi.fn(async () => ({
      command: 'claude --verbose',
      env: {},
      launchConfig: { agentArgs: '--verbose', agentEnv: {} },
      launchToken: 'legacy-token'
    }))
    runtimeCall.mockImplementation((request) =>
      request.method === 'terminal.createAgentSession'
        ? { ok: false, error: { code: 'method_not_found', message: 'No dispatch' } }
        : {
            ok: true,
            result: { terminal: { handle: 'legacy-terminal', worktreeId: 'wt-1', title: null } }
          }
    )
    await expect(
      createRuntimeAgentBackgroundTerminal({
        environmentId: 'env-1',
        worktreeId: 'wt-1',
        tabId: 'reserved-tab',
        leafId: 'reserved-leaf',
        agent: 'claude',
        legacy
      })
    ).resolves.toMatchObject({ terminal: { handle: 'legacy-terminal' } })
    expect(legacy).toHaveBeenCalledOnce()
    expect(runtimeCall.mock.calls.map(([request]) => request.method)).toEqual([
      'terminal.createAgentSession',
      'terminal.create'
    ])
    const prepared = runtimeCall.mock.calls[1][0].params
    expect(prepared).not.toHaveProperty('sessionOptions')
    expect(prepared).not.toHaveProperty('extraAgentArgs')
  })
})
