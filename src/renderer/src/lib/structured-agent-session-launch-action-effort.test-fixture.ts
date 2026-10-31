import { expect, it, vi, type Mock } from 'vitest'
import { CreateIntentParams } from '../../../shared/rpc-contract/structured-agent-session-params'
import {
  projectSourceControlActionLaunch,
  resolveSourceControlActionSessionOptions
} from '../../../shared/source-control-action-launch-preferences'
import { startStructuredAgentLaunch } from './structured-agent-session-launch'
import { holdStructuredAgentSessionLaunchOption } from './structured-agent-session-launch-options'
import { recordHostModelCatalogSnapshot } from '@/runtime/host-model-catalog-snapshots'
import { newAgentLaunchRequestId } from './agent-launch-request-id'

export function registerActionEffortCreateTests(
  mocks: {
    settings: Record<string, unknown>
    runtimeStatusByEnvironmentId: Map<
      string,
      { status: { capabilities: string[]; hostPlatform: string } }
    >
    exactSupport: Mock
    call: Mock<(target: unknown, method: string, params: unknown) => Promise<unknown>>
  },
  created: () => unknown
): void {
  const target = { kind: 'local' } as const
  it.each(['local', 'runtime:owner'] as const)(
    'carries a canonical raw source through actual admitted %s planning, create and recovery serialization',
    async (host) => {
      const { planAgentSessionLaunch } = await import('./agent-session-launch-plan')
      const { useAppStore } = await import('@/store')
      const { setLocalRuntimeCapabilitiesForTests } =
        await import('@/runtime/local-runtime-capabilities')
      const {
        STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY,
        STRUCTURED_AGENT_SESSION_CLIENT_LAUNCH_MODE_CAPABILITY
      } = await import('../../../shared/protocol-version')
      const { readStructuredAgentLaunchRecord } =
        await import('./agent-session/launch/structured-agent-session-launch-persistence')
      const { getStructuredLaunchStateBySessionId } =
        await import('./agent-session/launch/structured-agent-session-launch-registry')
      const capabilities = [
        STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY,
        STRUCTURED_AGENT_SESSION_CLIENT_LAUNCH_MODE_CAPABILITY
      ]
      setLocalRuntimeCapabilitiesForTests(capabilities)
      mocks.runtimeStatusByEnvironmentId.set('owner', {
        status: { capabilities, hostPlatform: 'linux' }
      })
      mocks.settings = { agentDefaultSurface: 'chat' }
      mocks.exactSupport.mockResolvedValue(true)
      const projection = projectSourceControlActionLaunch(
        {
          agentId: 'codex',
          agentArgs: `-c 'model="true"'`,
          launchPreferences: {
            agentId: 'codex',
            modelSelection: {
              base: 'default',
              options: { effort: { agentId: 'codex', value: 'high' } }
            }
          }
        },
        'codex',
        { basePrompt: 'Fix checks' }
      )
      try {
        for (const emptyChat of [false, true]) {
          const pending = Promise.withResolvers<unknown>()
          mocks.call.mockClear()
          mocks.call.mockReturnValue(pending.promise)
          const plan = planAgentSessionLaunch(useAppStore.getState(), {
            requestId: newAgentLaunchRequestId(),
            agent: 'codex',
            workspace: { kind: 'git-worktree', executionHostId: host },
            launchOptions: projection.sessionOptions,
            chatLaunchOptions: emptyChat ? {} : projection.chatSessionOptions,
            prompt: 'Fix checks'
          })
          expect(plan.route).toBe('structured-native-chat')
          const handle = plan.begin({}, { worktreeId: 'workspace-1', executionHostId: host })
          if (!handle) {
            throw new Error('Expected admitted Chat handle')
          }
          await vi.waitFor(() => expect(mocks.call).toHaveBeenCalledOnce())
          const params = CreateIntentParams.parse(mocks.call.mock.calls[0][2])
          const expected = {
            ...(host === 'local' ? { permissionMode: 'ask' } : {}),
            ...(emptyChat ? {} : { model: 'true', effort: 'high' })
          }
          expect(params.options ?? {}).toEqual(expected)
          expect(params.firstMessage?.selection ?? {}).toEqual(
            emptyChat ? {} : { model: 'true', effort: 'high' }
          )
          expect(plan.launchOptions).toEqual({ effort: 'high' })
          const state = getStructuredLaunchStateBySessionId(handle.sessionId)
          expect(state).toBeDefined()
          const persisted = readStructuredAgentLaunchRecord(handle.sessionId)
          for (const value of [params, state!.intent, persisted]) {
            expect(JSON.stringify(value)).not.toContain('chatLaunchOptions')
            expect(JSON.stringify(value)).not.toContain('chatSessionOptions')
            expect(JSON.stringify(value)).not.toContain('agentArgs')
          }
          const response = created()
          pending.resolve(response)
          await expect(handle.settlement).resolves.toMatchObject({
            kind: 'structured',
            sessionId: handle.sessionId
          })
        }
      } finally {
        mocks.settings = {}
        mocks.runtimeStatusByEnvironmentId.clear()
        setLocalRuntimeCapabilitiesForTests(null)
      }
    }
  )
  it.each(['codex', 'claude'] as const)(
    '%s action effort overlays remembered effort in create and yields to a held pick',
    async (agent) => {
      const model = agent === 'claude' ? 'claude-opus-5-5[1m]' : 'gpt-5.4'
      mocks.exactSupport.mockResolvedValue(true)
      mocks.settings = {
        nativeChatSessionOptions: {
          [agent]: { model, valuesByModel: { [model]: { effort: 'low' } } }
        }
      }
      recordHostModelCatalogSnapshot(target, agent, null, {
        origin: 'probe',
        fetchedAt: 1,
        models: [
          {
            id: model,
            label: model,
            isDefault: true,
            efforts: ['low', 'medium', 'high'].map((value) => ({ value, label: value }))
          }
        ]
      })
      mocks.call.mockImplementation(async () => created())
      try {
        for (const held of [undefined, 'medium']) {
          const launch = startStructuredAgentLaunch('workspace-1', agent, {
            requestId: newAgentLaunchRequestId(),
            executionHostId: 'local',
            prompt: 'opening text',
            launchOptions: resolveSourceControlActionSessionOptions(
              {
                agentId: agent,
                launchPreferences: { agentId: agent, options: { effort: 'high' } }
              },
              agent
            )
          })
          if (held) {
            holdStructuredAgentSessionLaunchOption(launch.sessionId, 'effort', held)
          }
          await launch.launchResult
          const params = CreateIntentParams.parse(
            mocks.call.mock.calls.findLast(([, method]) => method === 'agentSession.create')?.[2]
          )
          expect(params.firstMessage?.body.blocks).toEqual([{ type: 'text', text: 'opening text' }])
          expect(params.optionsMode).toBeUndefined()
          expect(params.options).toMatchObject({ effort: held ?? 'high' })
          expect(params.firstMessage?.selection).toMatchObject({ effort: held ?? 'high' })
          if (agent === 'claude') {
            expect(params.options?.model).toBe(model)
          }
          mocks.call.mockClear()
        }
      } finally {
        mocks.settings = {}
      }
    }
  )
}
