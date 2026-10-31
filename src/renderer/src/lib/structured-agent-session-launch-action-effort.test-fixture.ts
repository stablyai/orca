import { structuredAgentSessionStopControl } from '../../../shared/structured-agent-session-stop-control'
import { isStructuredAgentSessionMainAgentWorking } from '../../../shared/structured-agent-session-main-agent-working'
import { expect, it, vi, type Mock } from 'vitest'
import { CreateIntentParams } from '../../../shared/rpc-contract/structured-agent-session-params'
import { resolveSourceControlActionSessionOptions } from '../../../shared/source-control-action-launch-preferences'
import {
  startStructuredAgentLaunch,
  retryStructuredAgentSessionLaunch
} from './structured-agent-session-launch'
import { holdStructuredAgentSessionLaunchOption } from './structured-agent-session-launch-options'
import { recordHostModelCatalogSnapshot } from '@/runtime/host-model-catalog-snapshots'
import { newAgentLaunchRequestId } from './agent-launch-request-id'
import {
  mocks,
  deferred,
  start,
  createParams,
  target,
  created,
  draft
} from './structured-agent-session-launch-create-message.test-fixture'
import { structuredAgentSessionCreateFingerprint } from '../../../shared/structured-agent-session-mutation'
import { getStructuredAgentSessionReadOwner } from '@/components/native-chat/structured-agent-session-read-owner'
import { getStructuredAgentSessionPendingSends } from '@/components/native-chat/structured-agent-session-pending-sends'
import { readStructuredAgentLaunchRecord } from './agent-session/launch/structured-agent-session-launch-persistence'
import { getStructuredLaunchStateBySessionId } from './agent-session/launch/structured-agent-session-launch-registry'
import { structuredSessionSelectionController } from './structured-agent-session-selection-controller'
import { setRuntimeEnvironmentConnectionGenerationForTests } from '@/store/slices/runtime-status-connection-generation'
import { replaceRuntimeEnvironmentRevisions } from '@/runtime/runtime-environment-revision'

export function registerActionEffortCreateTests(
  mocks: {
    settings: Record<string, unknown>
    exactSupport: Mock
    call: Mock<(target: unknown, method: string, params: unknown) => Promise<unknown>>
  },
  created: () => unknown
): void {
  const target = { kind: 'local' } as const
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

export function registerCreateSelectionTests(): void {
  it('freezes the message and held options in create and publishes without another read or send', async () => {
    mocks.exactSupport.mockResolvedValue(true)
    recordHostModelCatalogSnapshot(target, 'codex', null, {
      origin: 'probe',
      fetchedAt: 1,
      defaultHoldsInEveryWorkspace: true,
      models: [
        {
          id: 'picked-model',
          label: 'Picked',
          isDefault: false,
          efforts: [
            { value: 'low', label: 'Low' },
            { value: 'high', label: 'High' }
          ]
        }
      ]
    })
    const create = deferred<unknown>()
    mocks.call.mockReturnValue(create.promise)
    const launch = start()
    holdStructuredAgentSessionLaunchOption(launch.sessionId, 'model', 'picked-model')
    holdStructuredAgentSessionLaunchOption(launch.sessionId, 'effort', 'high')
    await vi.waitFor(() => expect(mocks.call).toHaveBeenCalledOnce())
    const params = createParams()
    expect(params.firstMessage?.body.blocks).toEqual([{ type: 'text', text: 'opening text' }])
    expect(params.options).toEqual({ model: 'picked-model', effort: 'high' })
    expect(params.firstMessage?.selection).toEqual({ model: 'picked-model', effort: 'high' })
    expect(params.envelope.payloadFingerprint).toBe(
      structuredAgentSessionCreateFingerprint({ sessionId: launch.sessionId, ...params })
    )
    expect(getStructuredAgentSessionPendingSends(launch.sessionId)[0]?.phase).toBe('sending')
    const stop = vi.fn(async () => null)
    expect(
      structuredAgentSessionStopControl({
        published: false,
        host: { stopsConversation: true, stop },
        transportState: { turnId: null, isWorking: false },
        sends: { sending: true, stopSends: vi.fn() }
      }).canStop
    ).toBe(false)
    create.resolve(created())
    await launch.launchResult
    await expect(launch.promptDeliveryResult).resolves.toMatchObject({ delivered: true })
    const state = getStructuredAgentSessionReadOwner(launch.sessionId, target).getSnapshot().state
    expect(state.fence).toBe(1)
    const isWorking = isStructuredAgentSessionMainAgentWorking(null, state.submissions, state.fence)
    expect(isWorking).toBe(true)
    const control = structuredAgentSessionStopControl({
      published: true,
      host: { stopsConversation: true, stop },
      transportState: { turnId: null, isWorking },
      sends: { sending: false, stopSends: vi.fn() }
    })
    expect(control.canStop).toBe(true)
    await control.stop()
    expect(stop).toHaveBeenCalledWith(null, expect.any(Function))
    expect(draft(launch.sessionId)).toBe('')
    expect(mocks.inventory).not.toHaveBeenCalled()
    expect(mocks.call.mock.calls.map(([, method]) => method)).toEqual(['agentSession.create'])
  })

  it('keeps frozen selection completed when exact create proof arrives after the deadline', async () => {
    const create = deferred<unknown>()
    mocks.call.mockReturnValue(create.promise)
    const paired = { kind: 'environment', environmentId: 'frozen-generation' } as const
    replaceRuntimeEnvironmentRevisions([{ id: paired.environmentId, createdAt: 1 }])
    const launch = startStructuredAgentLaunch('workspace-1', 'codex', {
      requestId: newAgentLaunchRequestId(),
      executionHostId: 'runtime:frozen-generation',
      hostSeedOptions: { model: 'gpt-5.5' },
      prompt: 'opening text'
    })
    const first = holdStructuredAgentSessionLaunchOption(launch.sessionId, 'model', 'gpt-5.4')!
    await vi.waitFor(() => expect(mocks.call).toHaveBeenCalledOnce())
    const original = createParams()
    const owner = structuredSessionSelectionController(paired, launch.sessionId, 'codex')
    const carried = owner.pending()[0]!
    await vi.advanceTimersByTimeAsync(30_000)
    await expect(launch.launchResult).rejects.toThrow('Opening message outcome unknown.')
    await expect(launch.promptDeliveryResult).resolves.toMatchObject({
      delivered: false,
      unconfirmed: true
    })
    setRuntimeEnvironmentConnectionGenerationForTests(paired.environmentId, 2)
    expect(structuredSessionSelectionController(paired, launch.sessionId, 'codex')).toBe(owner)
    const middle = holdStructuredAgentSessionLaunchOption(
      launch.sessionId,
      'model',
      'gpt-5.3-codex'
    )!
    const newest = holdStructuredAgentSessionLaunchOption(launch.sessionId, 'model', 'gpt-5.4')!
    await expect(middle).resolves.toEqual({ kind: 'superseded' })
    const applied = deferred<unknown>()
    mocks.inventory.mockResolvedValue([])
    mocks.call.mockImplementation((_target, method) =>
      method === 'agentSession.setOption' ? applied.promise : Promise.resolve(created())
    )
    expect(retryStructuredAgentSessionLaunch('workspace-1', launch.sessionId)).toBe(false)
    const raw = getStructuredLaunchStateBySessionId(launch.sessionId)?.promise
    create.resolve(created(original))
    await raw
    await vi.waitFor(() =>
      expect(readStructuredAgentLaunchRecord(launch.sessionId)).toBeUndefined()
    )
    const creates = mocks.call.mock.calls.filter(([, method]) => method === 'agentSession.create')
    expect(creates).toHaveLength(1)
    expect(creates[0]?.[2]).toEqual(original)
    await expect(first).resolves.toEqual({ kind: 'unknown' })
    expect(carried.outcome?.kind).toBe('unknown')
    expect(owner.pending()).toHaveLength(1)
    expect(owner.pending()[0]).not.toBe(carried)
    applied.resolve({ ok: true, value: { options: { model: 'gpt-5.4' } } })
    await expect(newest).resolves.toMatchObject({ kind: 'accepted' })
    expect(owner.captureRead()).toHaveLength(2)
    expect(mocks.call.mock.calls.filter(([, method]) => method === 'agentSession.send')).toEqual([])
    expect(draft(launch.sessionId)).toBe('')
    replaceRuntimeEnvironmentRevisions([])
  })
}
