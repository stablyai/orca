// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeRpcResponse } from '../../../../shared/remote-runtime/rpc/runtime-rpc-envelope'
import type { AgentPickerEntry } from '../../../../shared/agent-launch/picker/agent-launch-picker'
import { agentPickerModels } from '../../../../shared/agent-launch/picker/agent-launch-picker-catalog'
import { unwrapRuntimeRpcResult } from '@/runtime/rpc/calls/runtime-rpc-result'
import {
  observeAgentPickerAcquisition,
  retryAgentPickerCatalog
} from './agent-launch-picker-acquisition'
import { AGENT_PICKER_CATALOG_RETRY_DELAYS_MS } from './agent-picker-catalog-jobs'
import { agentPickerModelCatalogReads } from './agent-launch-picker-host-reads'

const mocks = vi.hoisted(() => {
  const responses: RuntimeRpcResponse<unknown>[] = []
  const calls: { method: string; params: unknown }[] = []
  return { responses, calls }
})

// The remote runtime transport: each call answers with the next wire envelope the host sent.
vi.mock('@/runtime/rpc/calls/runtime-rpc-call', () => ({
  callRuntimeRpc: async (_target: unknown, method: string, params: unknown) => {
    mocks.calls.push({ method, params })
    const response = mocks.responses.shift()
    if (!response) {
      throw new Error('unexpected call')
    }
    return unwrapRuntimeRpcResult(response)
  }
}))

const meta = { runtimeId: 'wsl-runtime' }
/** What a host before 1.4.248 answers a session-less catalog read before its chat host is built. */
function refusal(reason: 'hostDisabled' | 'clientCapabilityMissing'): RuntimeRpcResponse<unknown> {
  return {
    id: 'r',
    ok: false,
    error: {
      code: 'structured_agent_session_unsupported',
      message: 'structured_agent_session_unsupported',
      data: { refusal: { code: 'structured_agent_session_unsupported', details: { reason } } }
    },
    _meta: meta
  }
}
function failure(code: string, message: string): RuntimeRpcResponse<unknown> {
  return { id: 'r', ok: false, error: { code, message }, _meta: meta }
}
const piCatalog: RuntimeRpcResponse<unknown> = {
  id: 'r',
  ok: true,
  result: {
    origin: 'probe',
    fetchedAt: 1,
    models: [
      { id: 'gateway/model-a', label: 'Model A', isDefault: true, efforts: [] },
      { id: 'gateway/model-b', label: 'Model B', isDefault: false, efforts: [] }
    ]
  },
  _meta: meta
}

const pi: AgentPickerEntry = {
  agent: 'pi',
  label: 'Pi',
  rows: [],
  surfaces: ['chat', 'terminal'],
  defaultSurface: 'chat',
  terminal: {},
  structured: {},
  catalog: { origin: 'unknown' }
}

function observe(key: string) {
  let latest: AgentPickerEntry[] = []
  let invalidate = () => {}
  const reads = agentPickerModelCatalogReads({
    target: { kind: 'environment', environmentId: 'wsl-env' },
    worktree: 'id:repo::/home/me/project'
  })
  const stop = observeAgentPickerAcquisition(
    key,
    [pi],
    {
      catalog: reads.catalog,
      refreshOnInvalidation: () => true,
      subscribeInvalidation: (listener) => {
        invalidate = listener
        return () => {}
      },
      support: async () => undefined
    },
    { selected: () => undefined, publish: (entries) => (latest = entries) }
  )
  return { stop, entry: () => latest[0], invalidate: () => invalidate() }
}
const BACKOFF_TOTAL_MS = AGENT_PICKER_CATALOG_RETRY_DELAYS_MS.reduce((sum, delay) => sum + delay, 0)

describe('agent picker catalog acquisition against a remote runtime', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    mocks.responses.length = 0
    mocks.calls.length = 0
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('retries an older host that refused the read before its chat host was built', async () => {
    mocks.responses.push(refusal('hostDisabled'), piCatalog)
    const picker = observe('host-not-built')
    await vi.advanceTimersByTimeAsync(0)
    // Still loading rather than settled on Pi's empty built-in list.
    expect(picker.entry().catalogRead).toBe('pending')

    await vi.advanceTimersByTimeAsync(AGENT_PICKER_CATALOG_RETRY_DELAYS_MS[0])
    expect(mocks.calls.map(({ method }) => method)).toEqual([
      'agentSession.modelCatalog',
      'agentSession.modelCatalog'
    ])
    expect(picker.entry().catalogRead).toBe('settled')
    expect(agentPickerModels(picker.entry(), 'chat').map(({ id }) => id)).toEqual(
      expect.arrayContaining(['gateway/model-a', 'gateway/model-b'])
    )
    picker.stop()
  })

  it('gives up after its bounded retries', async () => {
    mocks.responses.push(...Array.from({ length: 4 }, () => refusal('hostDisabled')))
    const picker = observe('host-never-built')
    await vi.advanceTimersByTimeAsync(BACKOFF_TOTAL_MS)
    expect(mocks.calls).toHaveLength(4)
    expect(picker.entry().catalogRead).toBe('failed')
    picker.stop()
  })

  it('does not retry a client the host will never serve', async () => {
    mocks.responses.push(refusal('clientCapabilityMissing'))
    const picker = observe('client-unsupported')
    await vi.advanceTimersByTimeAsync(20_000)
    expect(mocks.calls).toHaveLength(1)
    expect(picker.entry().catalogRead).toBe('unsupported')
    picker.stop()
  })

  it('stops retrying once the picker closes', async () => {
    mocks.responses.push(refusal('hostDisabled'))
    const picker = observe('closed')
    await vi.advanceTimersByTimeAsync(0)
    picker.stop()
    await vi.advanceTimersByTimeAsync(20_000)
    expect(mocks.calls).toHaveLength(1)
  })

  it('retries a read the dropped connection lost', async () => {
    mocks.responses.push(failure('reconnecting', 'Remote Orca runtime is reconnecting'), piCatalog)
    const picker = observe('reconnecting')
    await vi.advanceTimersByTimeAsync(0)
    expect(picker.entry().catalogRead).toBe('pending')
    await vi.advanceTimersByTimeAsync(AGENT_PICKER_CATALOG_RETRY_DELAYS_MS[0])
    expect(mocks.calls).toHaveLength(2)
    expect(picker.entry().catalogRead).toBe('settled')
    picker.stop()
  })

  it.each([
    ['a generic host error', failure('runtime_error', 'listing crashed')],
    ['a timeout', failure('runtime_timeout', 'Timed out waiting for the remote Orca runtime')]
  ])('shows %s at once without retrying', async (_name, response) => {
    mocks.responses.push(response)
    const picker = observe(`no-retry-${response.ok ? '' : response.error.code}`)
    await vi.advanceTimersByTimeAsync(0)
    expect(picker.entry().catalogRead).toBe('failed')
    await vi.advanceTimersByTimeAsync(BACKOFF_TOTAL_MS)
    expect(mocks.calls).toHaveLength(1)
    picker.stop()
  })

  it('a refresh during backoff reads at once and drops the pending retry', async () => {
    mocks.responses.push(refusal('hostDisabled'), piCatalog)
    const picker = observe('refresh-during-backoff')
    await vi.advanceTimersByTimeAsync(0)
    picker.invalidate()
    await vi.advanceTimersByTimeAsync(0)
    expect(mocks.calls).toHaveLength(2)
    expect(picker.entry().catalogRead).toBe('settled')
    await vi.advanceTimersByTimeAsync(BACKOFF_TOTAL_MS)
    expect(mocks.calls).toHaveLength(2)
    expect(picker.entry().catalogRead).toBe('settled')
    picker.stop()
  })

  it('a reopen during backoff reads at once and drops the pending retry', async () => {
    mocks.responses.push(refusal('hostDisabled'), piCatalog)
    const first = observe('reopen-during-backoff')
    await vi.advanceTimersByTimeAsync(0)
    expect(first.entry().catalogRead).toBe('pending')
    first.stop()
    const reopened = observe('reopen-during-backoff')
    await vi.advanceTimersByTimeAsync(0)
    expect(mocks.calls).toHaveLength(2)
    expect(reopened.entry().catalogRead).toBe('settled')
    await vi.advanceTimersByTimeAsync(BACKOFF_TOTAL_MS)
    expect(mocks.calls).toHaveLength(2)
    reopened.stop()
  })
})

const listed: AgentPickerEntry['catalog'] = {
  origin: 'probe',
  fetchedAt: 1,
  listingNamesConfiguredModel: false,
  models: [{ id: 'gemini-4-carbon', label: 'Gemini 4 Carbon', isDefault: false, efforts: [] }]
}

const antigravity: AgentPickerEntry = {
  agent: 'antigravity',
  label: 'Antigravity',
  rows: [{ kind: 'cli', agent: 'antigravity', chat: true }],
  surfaces: ['chat', 'terminal'],
  defaultSurface: 'chat',
  terminal: {},
  structured: {},
  catalog: { origin: 'unknown' },
  ownerKey: 'retry-test'
}

const settleReads = () => new Promise((resolve) => setTimeout(resolve, 0))

it('reads a failed catalog again while the picker stays open', async () => {
  let reads = 0
  let latest: AgentPickerEntry[] = []
  const stop = observeAgentPickerAcquisition(
    'retry-test',
    [antigravity],
    {
      catalog: async () => {
        reads += 1
        if (reads === 1) {
          throw new Error('agy models timed out')
        }
        return listed
      },
      support: async () => undefined
    },
    { publish: (entries) => (latest = entries), selected: () => undefined }
  )
  await settleReads()
  expect(latest[0]?.catalogRead).toBe('failed')

  retryAgentPickerCatalog('retry-test', 'antigravity')
  await settleReads()
  expect(reads).toBe(2)
  expect(latest[0]?.catalogRead).toBe('settled')
  expect(latest[0]?.catalog).toEqual(listed)
  stop()
})
