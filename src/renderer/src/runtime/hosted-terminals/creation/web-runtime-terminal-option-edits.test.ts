import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createCompatibleRuntimeStatusResponse } from '../../rpc/testing/runtime-compatibility-test-fixture'
import { clearRuntimeCompatibilityCache } from '../../rpc/compatibility/runtime-compatibility-cache'
import { replaceRuntimeEnvironmentRevisions } from '../../rpc/environment-revisions/runtime-environment-revision'
import * as capabilityProof from '../../rpc/compatibility/runtime-capability-proof'
import { callEnvironmentEnvelope } from '../../../web/preload-api/web-runtime-calls'
import { createWebRuntimeSessionTerminalResult } from './web-runtime-terminal-create-operation'
import { terminalSessionOptionInputs } from '../../../../../shared/agent-launch/startup/tui-agent-launch-command'

const host = vi.hoisted(() => ({
  client: { connectionEpoch: 1, runtimeId: 'runtime-a', call: vi.fn() },
  environment: { id: 'env-1', createdAt: 1, pairingRevision: 1 }
}))
vi.mock('../../../web/preload-api/web-runtime-session', () => ({
  getClientForEnvironment: () => host.client,
  manuallyDisconnectedEnvironmentIds: new Set<string>(),
  manuallyDisconnectedResponse: () => ({ ok: false }),
  requireActiveEnvironment: () => host.environment,
  resolveEnvironment: () => host.environment,
  runtimeCallQueuePool: { enqueue: (_id: string, _method: string, run: () => unknown) => run() },
  updateEnvironmentFromResponse: () => undefined
}))
vi.mock('@/store/index', () => ({ useAppStore: { getState: () => ({}) } }))
vi.mock('../../web-session-tabs-sync/inventory/web-runtime-session-snapshot', () => ({
  refreshWebRuntimeSessionTabsSnapshot: async () => undefined
}))

type Dispatch = {
  selector: string
  method: string
  params?: unknown
  timeoutMs?: number
  expectedEnvironmentPairingRevision?: number
  expectedEnvironmentRuntimeId?: string
}
const call = vi.fn<(request: Dispatch) => Promise<unknown>>()
const launch = () =>
  createWebRuntimeSessionTerminalResult({
    environmentId: 'env-1',
    worktreeId: 'repo::/worktree',
    agent: 'antigravity',
    terminalOptionEdits: { effort: null },
    activate: false,
    selectWorktree: false
  })

beforeEach(() => {
  vi.clearAllMocks()
  clearRuntimeCompatibilityCache()
  host.client.connectionEpoch++
  host.client.runtimeId = 'runtime-a'
  host.environment.pairingRevision = 1
  replaceRuntimeEnvironmentRevisions([host.environment])
  host.client.call.mockImplementation(async (method: string) =>
    method === 'status.get'
      ? createCompatibleRuntimeStatusResponse(host.client.runtimeId)
      : { id: 'created', ok: true, result: { terminal: { tabId: 'host-tab' } } }
  )
  call.mockImplementation((request) =>
    callEnvironmentEnvelope(
      request.selector,
      request.method,
      request.params,
      request.timeoutMs,
      request.expectedEnvironmentPairingRevision,
      request.expectedEnvironmentRuntimeId
    )
  )
  vi.stubGlobal('window', { api: { runtimeEnvironments: { call } } })
})
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

it('keeps the negotiated edit, destination proof and operation ID through ambiguous web creation', async () => {
  let creates = 0
  host.client.call.mockImplementation(async (method: string) => {
    if (method === 'status.get') {
      return createCompatibleRuntimeStatusResponse('runtime-a')
    }
    if (method === 'terminal.createAgentSession' && creates++ === 0) {
      clearRuntimeCompatibilityCache()
      throw new Error('Timed out waiting for the remote Orca runtime.')
    }
    return { id: 'created', ok: true, result: { terminal: { tabId: 'host-tab' } } }
  })
  expect((await launch()).outcome.status).toBe('created')
  const requests = call.mock.calls
    .map(([request]) => request)
    .filter((request) => request.method === 'terminal.createAgentSession')
  expect(requests).toHaveLength(2)
  expect(requests[1]).toEqual(requests[0])
  expect(requests[0]).toMatchObject({
    expectedEnvironmentPairingRevision: 1,
    expectedEnvironmentRuntimeId: 'runtime-a',
    params: { terminalOptionEdits: { effort: null }, clientOperationId: expect.any(String) }
  })
  expect(
    host.client.call.mock.calls.filter(([method]) => method === 'session.tabs.createTerminal')
  ).toEqual([])
})

it.each(['unsupported', 'failed'] as const)(
  'omits the field after %s edit negotiation and retains legacy default semantics',
  async (mode) => {
    if (mode === 'failed') {
      vi.spyOn(capabilityProof, 'runtimeEnvironmentCapabilityProof').mockRejectedValue(
        new Error('offline')
      )
    } else {
      host.client.call.mockImplementation(async (method: string) => {
        if (method === 'status.get') {
          const status = createCompatibleRuntimeStatusResponse('runtime-a')
          status.result.capabilities = status.result.capabilities?.filter(
            (value) => value !== 'agent.launch.terminal-option-edits.v1'
          )
          return status
        }
        return { id: 'created', ok: true, result: { terminal: { tabId: 'host-tab' } } }
      })
    }
    expect((await launch()).outcome.status).toBe('created')
    const request = call.mock.calls
      .map(([value]) => value)
      .find((value) => value.method === 'terminal.createAgentSession')
    expect(request?.params).not.toHaveProperty('terminalOptionEdits')
    const inputs = terminalSessionOptionInputs({
      agent: 'antigravity',
      shell: 'posix',
      agentArgs: undefined,
      sessionOptions: undefined,
      settings: { agentLaunchChoices: { antigravity: { options: { effort: 'low' } } } }
    })
    expect(inputs.sessionOptions).toMatchObject({ effort: 'low' })
  }
)

it.each(['runtime', 'pairing'] as const)(
  'fences a %s replacement after proof before any create reaches the host',
  async (replacement) => {
    const dispatch = call.getMockImplementation()!
    call.mockImplementation((request) => {
      if (request.method === 'terminal.createAgentSession') {
        if (replacement === 'runtime') {
          host.client.connectionEpoch++
          host.client.runtimeId = 'runtime-b'
        } else {
          host.environment.pairingRevision = 2
          replaceRuntimeEnvironmentRevisions([host.environment], {
            retired: ['env-1'],
            sameHost: []
          })
        }
      }
      return dispatch(request)
    })
    expect((await launch()).outcome.status).toBe('failed')
    expect(host.client.call.mock.calls.filter(([method]) => method !== 'status.get')).toEqual([])
  }
)
