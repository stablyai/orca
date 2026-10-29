import { expect, it, type Mock } from 'vitest'
import { CreateIntentParams } from '../../../shared/rpc-contract/structured-agent-session-params'
import { resolveSourceControlActionSessionOptions } from '../../../shared/source-control-action-launch-preferences'
import { startStructuredAgentLaunch } from './structured-agent-session-launch'
import { holdStructuredAgentSessionLaunchOption } from './structured-agent-session-launch-options'
import { recordHostModelCatalogSnapshot } from '@/runtime/host-model-catalog-snapshots'
import { newAgentLaunchRequestId } from './agent-launch-request-id'

export function registerActionEffortCreateTests(
  mocks: {
    settings: Record<string, unknown>
    call: Mock<(target: unknown, method: string, params: unknown) => Promise<unknown>>
  },
  created: () => unknown
): void {
  const target = { kind: 'local' } as const
  it.each(['codex', 'claude'] as const)(
    '%s action effort overlays remembered effort in create and yields to a held pick',
    async (agent) => {
      const model = agent === 'claude' ? 'claude-opus-5-5[1m]' : 'gpt-5.4'
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
