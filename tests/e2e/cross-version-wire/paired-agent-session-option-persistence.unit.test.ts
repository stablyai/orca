import { afterEach, expect, it, vi } from 'vitest'
import { sendRemoteRuntimeRequest } from '../../../src/shared/remote-runtime/remote-runtime-client'
import { parsePairingCode } from '../../../src/shared/pairing'
import { pairedRuntimeConnectionFromOffer } from '../../../src/shared/paired-runtime-connection'
import { ELECTRON_REMOTE_RUNTIME_CLIENT_CAPABILITIES } from '../../../src/shared/electron-remote-runtime-client-capabilities'
import { OrcaRuntimeService } from '../../../src/main/runtime/orca-runtime'
import { OrcaRuntimeRpcServer } from '../../../src/main/runtime/runtime-rpc'
import { RuntimeClientSettingsController } from '../../../src/main/runtime/runtime-client-settings'
import type { RuntimeClientSettings } from '../../../src/main/runtime/runtime-client-settings-shape'
import { AgentModelCatalogStore } from '../../../src/main/native-chat/agent-model-catalog/agent-model-catalog-store'
import { createAgentModelCatalogService } from '../../../src/main/native-chat/agent-model-catalog/agent-model-catalog-service'
import { agentModelCatalogFingerprintForRecord } from '../../../src/main/native-chat/agent-model-catalog/agent-model-catalog-fingerprint'
import { CLIENT_UI_METHODS } from '../../../src/main/runtime/rpc/methods/client-ui'
import { STATUS_METHODS } from '../../../src/main/runtime/rpc/methods/status'
import { STRUCTURED_AGENT_SESSION_METHODS } from '../../../src/main/runtime/rpc/methods/structured-agent-session'
import {
  createRestTestRig,
  REST_TEST_SESSION
} from '../../../src/main/native-chat/agent-session-wire/structured-agent-session-rest-test-rig'
import {
  hostTestAttachParams,
  hostTestOperationId
} from '../../../src/main/native-chat/agent-session-wire/structured-agent-session-host-test-data'
import { setStructuredAgentSessionHost } from '../../../src/main/native-chat/agent-session-wire/structured-agent-session-registry'
import { computeAgentSessionPayloadFingerprint } from '../../../src/shared/agent-session-mutation-envelope'
import type { GlobalSettings } from '../../../src/shared/global-settings-types'
import { getDefaultSettings } from '../../../src/shared/constants'
import type {
  AgentSessionMutationResult,
  AgentSessionOptionResult,
  AgentSessionOptionsResult
} from '../../../src/shared/agent-session-wire'
import { CODEX_SESSION_OPTION_CATALOG } from '../../../src/shared/agent-session-option-catalog-claude-codex'
import {
  applyStructuredAgentSessionOptions,
  createStructuredAgentSessionOptionState,
  structuredAgentSessionOptionPicks,
  structuredAgentSessionOptionSnapshot
} from '../../../src/shared/structured-agent-session-options'
import {
  structuredAgentSessionOptionView,
  structuredAgentSessionSendSelection
} from '../../../src/shared/structured-agent-session-option-view'
import { runtimeStub } from './structured-agent-session-surface-execution'
import { enqueueSessionOptionSettingsWrite } from '../../../src/renderer/src/components/native-chat/native-chat-session-option-settings-write'
import { clearRuntimeCompatibilityCacheForTests } from '../../../src/renderer/src/runtime/runtime-rpc-client'
import type { NativeChatSessionOptionSettingsMutation } from '../../../src/shared/native-chat/input/native-chat-session-options'

const pairedPort = vi.hoisted(() => ({ call: vi.fn() }))
vi.mock('../../../src/renderer/src/runtime/runtime-rpc-environment-call', () => ({
  callRuntimeEnvironmentWithRevision: pairedPort.call
}))
afterEach(() => {
  vi.unstubAllGlobals()
  clearRuntimeCompatibilityCacheForTests()
})

it('pairs to host-owned options and persists only a genuine pick on that host', async () => {
  const rig = await createRestTestRig({ idleSweep: { intervalMs: 3_600_000 } })
  rig.adapter.readOptions.mockResolvedValue({ models: [], current: {} })
  const catalogStore = new AgentModelCatalogStore()
  const modelCatalog = createAgentModelCatalogService({
    store: catalogStore,
    getConversation: (id) => rig.store.getConversation(id) ?? undefined,
    getRecord: (id) => rig.store.getRecord(id) ?? undefined,
    drivesRecord: () => true,
    resolveAccountHome: async () => {
      const record = rig.store.getRecord(REST_TEST_SESSION)
      if (!record) {
        throw new Error('attached host record missing')
      }
      return record.accountHome
    }
  })
  let settings = { ...getDefaultSettings(rig.root), experimentalNativeChat: true }
  let localSettings: GlobalSettings = {
    ...getDefaultSettings(rig.root),
    nativeChatSessionOptions: { codex: { model: 'local-A', valuesByModel: {} } }
  }
  const localBefore = JSON.stringify(localSettings)
  const localController = new RuntimeClientSettingsController({
    getSettings: () => localSettings,
    updateSettings: (updates) => {
      localSettings = { ...localSettings, ...updates }
    }
  })
  const localCall = vi.fn(
    async ({
      method,
      params
    }: {
      method: string
      params: NativeChatSessionOptionSettingsMutation
    }) => {
      if (method === 'settings.mutateNativeChatSessionOptions') {
        localController.updateNativeChatSessionOptions(params)
      }
      return { id: 'local', ok: true, result: {}, _meta: { runtimeId: 'local-A' } }
    }
  )
  vi.stubGlobal('window', { api: { runtime: { call: localCall } } })
  const updateSettings = vi.fn((updates: Partial<GlobalSettings>) => {
    settings = { ...settings, ...updates }
  })
  const controller = new RuntimeClientSettingsController({
    getSettings: () => settings,
    updateSettings
  })
  const runtime = Object.assign(new OrcaRuntimeService(), runtimeStub(), {
    getClientSettings: () => controller.get(),
    updateClientNativeChatSessionOptions: controller.updateNativeChatSessionOptions.bind(controller)
  })
  const server = new OrcaRuntimeRpcServer({
    runtime,
    userDataPath: rig.root,
    methods: [...STATUS_METHODS, ...CLIENT_UI_METHODS, ...STRUCTURED_AGENT_SESSION_METHODS],
    enableWebSocket: true,
    wsPort: 0
  })
  try {
    await rig.restart({ modelCatalog })
    const attached = await rig.host.attach({ callerKey: 'founder' }, hostTestAttachParams(null))
    expect(attached.ok).toBe(true)
    const acquisitionsAfterAttach = rig.adapter.acquire.mock.calls.length
    const record = rig.store.getRecord(REST_TEST_SESSION)
    if (!record) {
      throw new Error('attached host record missing')
    }
    catalogStore.recordSuccess(
      agentModelCatalogFingerprintForRecord(record),
      'codex',
      {
        origin: 'probe',
        complete: true,
        models: CODEX_SESSION_OPTION_CATALOG.models.map(({ id, label }) => ({
          id,
          label,
          isDefault: false,
          efforts: []
        }))
      },
      'discovery'
    )
    await modelCatalog.prepareSaved({
      agent: 'codex',
      sessionId: REST_TEST_SESSION,
      inSessionWorkspace: true
    })
    setStructuredAgentSessionHost(rig.host)
    await server.start()
    const offer = server.createPairingOffer({ name: 'options-consumer', scope: 'runtime' })
    if (!offer.available) {
      throw new Error('pairing unavailable')
    }
    const parsed = parsePairingCode(offer.pairingUrl)
    if (!parsed) {
      throw new Error('invalid pairing offer')
    }
    const connection = pairedRuntimeConnectionFromOffer(parsed)
    pairedPort.call.mockImplementation(({ environmentId, method, params }) => {
      expect(environmentId).toBe('paired-host-B')
      return sendRemoteRuntimeRequest(
        connection,
        method,
        params,
        5_000,
        undefined,
        undefined,
        ELECTRON_REMOTE_RUNTIME_CLIENT_CAPABILITIES
      )
    })
    const client = {
      async call<T>(method: string, params?: unknown) {
        const response = await sendRemoteRuntimeRequest<T>(
          connection,
          method,
          params,
          5_000,
          undefined,
          undefined,
          ELECTRON_REMOTE_RUNTIME_CLIENT_CAPABILITIES
        )
        if (!response.ok) {
          throw new Error(JSON.stringify(response.error))
        }
        return response
      }
    }
    const read = async () =>
      (
        await client.call<AgentSessionOptionsResult>('agentSession.options', {
          sessionId: REST_TEST_SESSION
        })
      ).result
    const report = await read()
    expect(rig.adapter.readOptions).toHaveBeenCalled()
    expect(report.current.model).toBeUndefined()
    expect(report.models.length).toBeGreaterThan(0)
    expect(report.models.every((entry) => entry.isDefault === false)).toBe(true)
    const seed = CODEX_SESSION_OPTION_CATALOG
    const cold = applyStructuredAgentSessionOptions(
      createStructuredAgentSessionOptionState('codex', seed),
      seed,
      report
    )
    expect(structuredAgentSessionSendSelection(cold)).toBeUndefined()
    expect(updateSettings).not.toHaveBeenCalled()
    const model = report.models.find((entry) => entry.id !== '')
    if (!model) {
      throw new Error('host inventory missing')
    }
    const beforePending = structuredClone(cold.record)
    const pending = structuredAgentSessionOptionView(cold, undefined, { model: model.id })
    expect(
      structuredAgentSessionOptionSnapshot(pending).find((row) => row.id === 'model')?.kind
    ).toMatchObject({ currentValue: model.id })
    expect(cold.record).toEqual(beforePending)
    expect(structuredAgentSessionSendSelection(pending)).toBeUndefined()
    expect(updateSettings).not.toHaveBeenCalled()
    const fields = { key: 'model', value: model.id }
    const picked = await client.call<AgentSessionMutationResult<AgentSessionOptionResult>>(
      'agentSession.setOption',
      {
        ...fields,
        envelope: {
          sessionId: REST_TEST_SESSION,
          clientOperationId: hostTestOperationId(),
          expectedRuntimeFence: rig.store.getRecord(REST_TEST_SESSION)!.lease.runtimeFence,
          payloadFingerprint: computeAgentSessionPayloadFingerprint({
            method: 'agentSession.setOption',
            sessionId: REST_TEST_SESSION,
            fields
          })
        }
      }
    )
    if (!picked.result.ok) {
      throw new Error(`pick refused: ${picked.result.refusal.code}`)
    }
    expect(picked.result.value.options).toMatchObject({ model: model.id })
    const picks = structuredAgentSessionOptionPicks(cold, picked.result.value.options ?? {})
    expect(picks).toContainEqual({ modelId: model.id, optionId: 'model', value: model.id })
    await enqueueSessionOptionSettingsWrite(
      { kind: 'environment', environmentId: 'paired-host-B' },
      { type: 'apply-picks', agent: 'codex', picks }
    )
    expect(settings.nativeChatSessionOptions).toMatchObject({
      codex: { model: model.id }
    })
    expect(updateSettings).toHaveBeenCalledTimes(1)
    const saved = await client.call<{ settings: RuntimeClientSettings }>('settings.get')
    expect(saved.result.settings).toEqual(controller.get())
    expect(saved.result.settings).not.toHaveProperty('nativeChatSessionOptions')
    expect(rig.store.getRecord(REST_TEST_SESSION)?.options?.model).toBe(model.id)
    const shown = applyStructuredAgentSessionOptions(cold, seed, await read())
    expect(
      structuredAgentSessionOptionSnapshot(shown).find((row) => row.id === 'model')?.kind
    ).toMatchObject({ currentValue: model.id })
    // Codex uses host-owned options; per-send model overrides are Claude-only.
    expect(structuredAgentSessionSendSelection(shown)).toBeUndefined()
    expect(JSON.stringify(localSettings)).toBe(localBefore)
    expect(localCall).not.toHaveBeenCalled()
    expect(rig.adapter.acquire).toHaveBeenCalledTimes(acquisitionsAfterAttach)
  } finally {
    await server.stop()
    modelCatalog.stop()
    setStructuredAgentSessionHost(null)
    await rig.dispose()
  }
})
