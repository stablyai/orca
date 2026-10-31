import {
  RUNTIME_PROTOCOL_VERSION,
  MIN_COMPATIBLE_RUNTIME_CLIENT_VERSION
} from '../../../shared/protocol-version'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { callGitHubTargetOperation } from './github-work-item-target-request'
import { clearRuntimeCompatibilityCache } from '@/runtime/runtime-rpc-client'
import { replaceRuntimeEnvironmentRevisions } from '@/runtime/runtime-environment-revision'
import { GITHUB_EXACT_WORK_ITEM_TARGET_RUNTIME_CAPABILITY as capability } from '../../../shared/source-control-runtime-capabilities'

vi.mock('@/store', () => ({ useAppStore: { getState: () => ({ repos: [] }) } }))
const ownerRepo = { owner: 'fork', repo: 'widgets', host: 'github.corp' }
let runtime = 'a'
let capable = true
const writes: unknown[] = []
let afterProbe: () => void = () => {}
const call = vi.fn(async (request) => {
  // The actual callRuntimeRpc must carry the captured revision/runtime through its compatibility await.
  if (request.expectedEnvironmentRuntimeId && request.expectedEnvironmentRuntimeId !== runtime) {
    return {
      ok: false,
      error: { code: 'runtime_environment_changed', message: 'Connection changed' }
    }
  }
  const result =
    request.method === 'status.get'
      ? {
          runtimeProtocolVersion: RUNTIME_PROTOCOL_VERSION,
          minCompatibleRuntimeClientVersion: MIN_COMPATIBLE_RUNTIME_CLIENT_VERSION,
          runtimeId: runtime,
          capabilities: capable ? [capability] : []
        }
      : (writes.push(request.params), { ok: true })
  if (request.method === 'status.get') {
    afterProbe()
  }
  return { ok: true, result, _meta: { runtimeId: runtime } }
})
function update() {
  return callGitHubTargetOperation({
    target: { kind: 'environment', environmentId: 'paired' },
    ownerRepo,
    method: 'github.updateIssue',
    params: { repo: 'clone', number: 93, updates: { body: 'edit' } },
    local: async () => {
      throw new Error('wrong transport')
    }
  })
}
beforeEach(() => {
  writes.length = 0
  runtime = 'a'
  capable = true
  afterProbe = () => {}
  call.mockClear()
  clearRuntimeCompatibilityCache()
  replaceRuntimeEnvironmentRevisions([{ id: 'paired', createdAt: 1, pairingRevision: 1 }])
  vi.stubGlobal('window', { api: { runtimeEnvironments: { call } } })
})
afterEach(() => vi.unstubAllGlobals())

it('carries the exact target and captured authority to the actual runtime client dispatch', async () => {
  await update()
  expect(writes).toEqual([{ repo: 'clone', number: 93, updates: { body: 'edit' }, ownerRepo }])
  expect(call).toHaveBeenLastCalledWith(
    expect.objectContaining({
      expectedEnvironmentRuntimeId: 'a',
      expectedEnvironmentPairingRevision: 1
    })
  )
})
it.each([false, true])(
  'rejects A evidence after replacement by capable=%s B and permits a fresh user attempt',
  async (bCapable) => {
    afterProbe = () => {
      runtime = 'b'
      capable = bCapable
      afterProbe = () => {}
    }
    await expect(update()).rejects.toThrow()
    expect(writes).toEqual([])
    clearRuntimeCompatibilityCache()
    if (bCapable) {
      await update()
      expect(writes).toHaveLength(1)
    } else {
      await expect(update()).rejects.toThrow('Update Orca')
      expect(writes).toEqual([])
    }
  }
)
it('does not turn a status transport failure into unsupported or send a generic write', async () => {
  call.mockRejectedValueOnce(new Error('network down'))
  await expect(update()).rejects.toThrow('network down')
  expect(writes).toEqual([])
})
it('rejects re-pairing between probe and send, before any destination effect', async () => {
  afterProbe = () =>
    replaceRuntimeEnvironmentRevisions([{ id: 'paired', createdAt: 1, pairingRevision: 2 }], {
      retired: ['paired'],
      sameHost: []
    })
  await expect(update()).rejects.toThrow()
  expect(writes).toEqual([])
})
