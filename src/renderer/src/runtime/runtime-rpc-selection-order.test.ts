import { beforeEach, expect, it, vi } from 'vitest'
import { createStructuredSessionSelectionController } from '../../../shared/structured-agent-session-selection-operations'
import {
  MIN_COMPATIBLE_RUNTIME_CLIENT_VERSION,
  RUNTIME_PROTOCOL_VERSION
} from '../../../shared/protocol-version'
import { callRuntimeRpc, clearRuntimeCompatibilityCacheForTests } from './runtime-rpc-client'

const runtimeCall = vi.fn()
const runtimeEnvironmentCall = vi.fn()
beforeEach(() => {
  clearRuntimeCompatibilityCacheForTests()
  runtimeCall.mockReset()
  runtimeEnvironmentCall.mockReset()
  vi.stubGlobal('window', {
    api: { runtime: { call: runtimeCall }, runtimeEnvironments: { call: runtimeEnvironmentCall } }
  })
})

it.each(['local', 'environment'] as const)(
  'issues Plan and legacy tier before Send while the model response waits (%s)',
  async (kind) => {
    const delayedModel = Promise.withResolvers<unknown>()
    const host = { permissionMode: 'full-access', serviceTier: 'default', model: 'opus' }
    const enqueued: string[] = []
    const receive = async ({
      method,
      params
    }: {
      method: string
      params?: { key?: string; value?: string }
    }) => {
      if (method === 'status.get') {
        return {
          id: method,
          ok: true,
          result: {
            runtimeProtocolVersion: RUNTIME_PROTOCOL_VERSION,
            minCompatibleRuntimeClientVersion: MIN_COMPATIBLE_RUNTIME_CLIENT_VERSION
          },
          _meta: { runtimeId: 'remote-runtime' }
        }
      }
      enqueued.push(params?.key ?? method)
      if (method === 'agentSession.setOption') {
        if (params?.key === 'model') {
          host.model = params.value!
          return delayedModel.promise
        }
        if (params?.key === 'permissionMode') {
          host.permissionMode = params.value!
        }
        if (params?.key === 'serviceTier') {
          host.serviceTier = params.value!
        }
      }
      return { id: method, ok: true, result: { ...host }, _meta: { runtimeId: 'remote-runtime' } }
    }
    runtimeCall.mockImplementation(receive)
    runtimeEnvironmentCall.mockImplementation(receive)
    const target =
      kind === 'local'
        ? { kind: 'local' as const }
        : { kind: 'environment' as const, environmentId: 'w2-peer' }
    const controller = createStructuredSessionSelectionController(() => {})
    const dispatch = () =>
      controller.flush(async (operation) => {
        await callRuntimeRpc(target, 'agentSession.setOption', {
          key: operation.key,
          value: operation.value
        })
        return { kind: 'accepted' as const, options: { [operation.key]: operation.value } }
      })
    controller.issue('model', 'sonnet', null)
    dispatch()
    const draining = controller.drain()
    await vi.waitFor(() => expect(enqueued).toEqual(['model']))
    controller.issue('permissionMode', 'plan', null)
    controller.issue('serviceTier', 'priority', 'sonnet')
    void dispatch()
    const delivered = await callRuntimeRpc(target, 'agentSession.send', {})
    expect(enqueued).toEqual(['model', 'serviceTier', 'permissionMode', 'agentSession.send'])
    expect(delivered).toMatchObject({
      model: 'sonnet',
      permissionMode: 'plan',
      serviceTier: 'priority'
    })
    expect(controller.overlay()).toMatchObject({ permissionMode: 'plan', serviceTier: 'priority' })
    delayedModel.resolve({
      id: 'model',
      ok: true,
      result: {},
      _meta: { runtimeId: 'remote-runtime' }
    })
    await draining
    controller.retire(controller.captureRead())
    expect(controller.overlay()).toEqual({})
    expect(host).toEqual(delivered)
  }
)
