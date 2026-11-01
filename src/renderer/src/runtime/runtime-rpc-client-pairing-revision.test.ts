import { beforeEach, expect, it, vi } from 'vitest'
import {
  MIN_COMPATIBLE_RUNTIME_CLIENT_VERSION,
  RUNTIME_PROTOCOL_VERSION
} from '../../../shared/protocol-version'
import { createNativeChatRestartStore } from '../components/native-chat-restart-runtime-store'
import { toast } from 'sonner'
import { callRuntimeRpc, clearRuntimeCompatibilityCacheForTests } from './runtime-rpc-client'
import { replaceRuntimeEnvironmentRevisions } from './runtime-environment-revision'
import { stubRuntimeEnvironmentBridge } from './runtime-environment-bridge-fixture'

vi.mock('./structured-agent-session-status-feed', () => ({
  getStructuredAgentSessionStatusFeed: () => ({
    activate: () => () => {},
    subscribe: () => () => {},
    getSnapshot: () => new Map()
  })
}))
vi.mock('sonner', async () =>
  (await import('../components/native-chat-resume-sonner-mock.test-support')).resumeSonnerMock()
)
const runtimeEnvironmentCall = vi.fn()

beforeEach(() => {
  clearRuntimeCompatibilityCacheForTests()
  replaceRuntimeEnvironmentRevisions([])
  runtimeEnvironmentCall.mockReset()
  stubRuntimeEnvironmentBridge({ call: runtimeEnvironmentCall })
})

it('captures the pairing revision before awaiting the compatibility probe', async () => {
  let resolveStatus!: (response: unknown) => void
  replaceRuntimeEnvironmentRevisions([{ id: 'env-cas', createdAt: 1, pairingRevision: 10 }])
  runtimeEnvironmentCall.mockImplementation(({ method }: { method: string }) => {
    if (method === 'status.get') {
      return new Promise((resolve) => {
        resolveStatus = resolve
      })
    }
    return Promise.resolve({
      id: method,
      ok: true,
      result: { ok: true },
      _meta: { runtimeId: 'remote-runtime' }
    })
  })

  const request = callRuntimeRpc({ kind: 'environment', environmentId: 'env-cas' }, 'repo.list')
  await vi.waitFor(() => expect(runtimeEnvironmentCall).toHaveBeenCalledTimes(1))
  replaceRuntimeEnvironmentRevisions([{ id: 'env-cas', createdAt: 1, pairingRevision: 11 }])
  resolveStatus({
    id: 'status',
    ok: true,
    result: {
      runtimeId: 'remote-runtime',
      graphStatus: 'ready',
      runtimeProtocolVersion: RUNTIME_PROTOCOL_VERSION,
      minCompatibleRuntimeClientVersion: MIN_COMPATIBLE_RUNTIME_CLIENT_VERSION
    },
    _meta: { runtimeId: 'remote-runtime' }
  })

  await expect(request).resolves.toEqual({ ok: true })
  expect(runtimeEnvironmentCall).toHaveBeenCalledTimes(2)
  expect(runtimeEnvironmentCall).toHaveBeenNthCalledWith(1, {
    selector: 'env-cas',
    method: 'status.get',
    timeoutMs: undefined,
    expectedEnvironmentPairingRevision: 10
  })
  expect(runtimeEnvironmentCall).toHaveBeenLastCalledWith({
    selector: 'env-cas',
    method: 'repo.list',
    params: undefined,
    timeoutMs: undefined,
    expectedEnvironmentPairingRevision: 10
  })
})

it.each([true, false])(
  'checks occurrence authority after real compatibility preparation (retired: %s)',
  async (retired) => {
    const store = createNativeChatRestartStore({ kind: 'environment', environmentId: 'env-cas' })
    const status = Promise.withResolvers<unknown>()
    let holdCompatibility = false
    const candidate = {
      sessionId: 'a',
      workspaceId: 'workspace',
      agent: 'codex',
      trigger: 'update',
      latestPrompt: 'Fix it',
      recordedAt: 1
    }
    const response = (method: string, result: unknown) => ({
      id: method,
      ok: true,
      result,
      _meta: { runtimeId: 'r1' }
    })
    runtimeEnvironmentCall.mockImplementation(async ({ method, params }) => {
      if (method === 'status.get') {
        return holdCompatibility
          ? status.promise
          : response(method, {
              runtimeId: 'r1',
              graphStatus: 'ready',
              runtimeProtocolVersion: RUNTIME_PROTOCOL_VERSION,
              minCompatibleRuntimeClientVersion: MIN_COMPATIBLE_RUNTIME_CLIENT_VERSION
            })
      }
      return response(
        method,
        method === 'agentSession.restartResumable'
          ? { sessions: [candidate], failed: [] }
          : {
              sessions: [],
              failed: [],
              continued: params.sessionIds.map((sessionId: string) => ({
                sessionId,
                outcome: 'continued'
              }))
            }
      )
    })
    try {
      await store.readNativeChatRestartOffer()
      clearRuntimeCompatibilityCacheForTests()
      holdCompatibility = true
      vi.mocked(toast).mockClear()
      const action = store.continueNativeChatRestartOffer(['a'])
      await vi.waitFor(() =>
        expect(
          runtimeEnvironmentCall.mock.calls.filter(([args]) => args.method === 'status.get')
        ).toHaveLength(2)
      )
      if (retired) {
        store.dispose()
      }
      status.resolve(
        response('status.get', {
          runtimeId: 'r1',
          graphStatus: 'ready',
          runtimeProtocolVersion: RUNTIME_PROTOCOL_VERSION,
          minCompatibleRuntimeClientVersion: MIN_COMPATIBLE_RUNTIME_CLIENT_VERSION
        })
      )
      await action
      const sent = runtimeEnvironmentCall.mock.calls.filter(
        ([args]) => args.method === 'agentSession.restartContinue'
      )
      expect(sent).toHaveLength(retired ? 0 : 1)
      if (retired) {
        expect(toast).not.toHaveBeenCalled()
      } else {
        expect(sent[0][0].params).toEqual({ sessionIds: ['a'] })
      }
    } finally {
      store.dispose()
    }
  }
)
