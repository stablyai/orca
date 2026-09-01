import { describe, expect, it, vi } from 'vitest'
import type { RuntimeRpcResponse } from '../../../shared/runtime-rpc-envelope'
import type { AgentCatalogSnapshot } from '../../../shared/agent-catalog-snapshot'
import { createWebAgentCatalogSync, projectWebAgentCatalog } from './web-agent-catalog-sync'

const CUSTOM_ID = 'custom-agent:codex:01234567-89ab-4cde-8f01-23456789abcd'

function hostSnapshot(overrides: Partial<AgentCatalogSnapshot> = {}): AgentCatalogSnapshot {
  return {
    version: 1,
    revision: 7,
    defaultAgent: CUSTOM_ID,
    disabledAgents: ['gemini'],
    customAgents: [
      {
        id: CUSTOM_ID,
        baseAgent: 'codex',
        label: 'Reviewer',
        args: '--review',
        syncEnv: true,
        status: 'ready',
        envState: 'available',
        availabilityCheck: 'launch-reported'
      }
    ],
    deletedCustomAgents: [],
    ...overrides
  } as AgentCatalogSnapshot
}

function ok(result: unknown): RuntimeRpcResponse<unknown> {
  return { id: 'call-1', ok: true, result, _meta: { runtimeId: 'runtime-1' } }
}

function failure(code: string): RuntimeRpcResponse<unknown> {
  return {
    id: 'call-1',
    ok: false,
    error: { code, message: code },
    _meta: { runtimeId: 'runtime-1' }
  }
}

describe('web agent catalog sync', () => {
  it('projects the host catalog into the local snapshot shape the desktop UI reads', async () => {
    const call = vi.fn(async (method: string) =>
      method === 'settings.agentCatalog.get'
        ? ok({ agentCatalog: hostSnapshot() })
        : failure('method_not_found')
    )
    const sync = createWebAgentCatalogSync({
      call,
      isPaired: () => true,
      onRevisionApplied: vi.fn()
    })

    const snapshot = await sync.getLocal()

    expect(snapshot.revision).toBe(7)
    expect(snapshot.defaultAgent).toBe(CUSTOM_ID)
    expect(snapshot.disabledAgents).toEqual(['gemini'])
    expect(snapshot.customAgents).toEqual([
      {
        status: 'ready',
        definition: {
          id: CUSTOM_ID,
          baseAgent: 'codex',
          label: 'Reviewer',
          args: '--review',
          syncEnv: true
        },
        envSummary: { entryCount: 0, bytes: 0 },
        availabilityReason: 'custom-path'
      }
    ])
    // One fetch is cached for every consumer of the shared catalog store.
    await sync.getLocal()
    expect(call).toHaveBeenCalledTimes(1)
  })

  it('falls back to the settings.get piggyback on a host without the dedicated read', async () => {
    const call = vi.fn(async (method: string) =>
      method === 'settings.agentCatalog.get'
        ? failure('method_not_found')
        : ok({ settings: {}, agentCatalog: hostSnapshot({ revision: 3 }) })
    )
    const sync = createWebAgentCatalogSync({
      call,
      isPaired: () => true,
      onRevisionApplied: vi.fn()
    })

    const snapshot = await sync.getLocal()

    expect(snapshot.revision).toBe(3)
    expect(snapshot.customAgents).toHaveLength(1)
    expect(call.mock.calls.map(([method]) => method)).toEqual([
      'settings.agentCatalog.get',
      'settings.get'
    ])
  })

  it('degrades to the built-in catalog when the host publishes none', async () => {
    const call = vi.fn(async (method: string) =>
      method === 'settings.agentCatalog.get' ? failure('method_not_found') : ok({ settings: {} })
    )
    const sync = createWebAgentCatalogSync({
      call,
      isPaired: () => true,
      onRevisionApplied: vi.fn()
    })

    const snapshot = await sync.getLocal()

    expect(snapshot).toMatchObject({
      version: 1,
      revision: 0,
      defaultAgent: null,
      disabledAgents: [],
      customAgents: [],
      projection: { status: 'ready' }
    })
  })

  it('keeps the cached catalog through a transient failure', async () => {
    let dedicated: RuntimeRpcResponse<unknown> = ok({ agentCatalog: hostSnapshot() })
    const sync = createWebAgentCatalogSync({
      call: async () => dedicated,
      isPaired: () => true,
      onRevisionApplied: vi.fn()
    })
    await sync.getLocal()

    dedicated = failure('runtime_unavailable')
    sync.announceRevision(8)
    await Promise.resolve()
    await Promise.resolve()

    expect((await sync.getLocal()).revision).toBe(7)
  })

  it('refetches on an announced revision and notifies so consumers reload', async () => {
    let snapshot = hostSnapshot()
    const call = vi.fn(async () => ok({ agentCatalog: snapshot }))
    const onRevisionApplied = vi.fn()
    const sync = createWebAgentCatalogSync({ call, isPaired: () => true, onRevisionApplied })
    expect((await sync.getLocal()).revision).toBe(7)

    snapshot = hostSnapshot({ revision: 9, customAgents: [] })
    sync.announceRevision(9)
    await vi.waitFor(() => expect(onRevisionApplied).toHaveBeenCalledWith(9))

    const next = await sync.getLocal()
    expect(next.revision).toBe(9)
    expect(next.customAgents).toEqual([])
    // An already-applied revision costs no round-trip.
    sync.announceRevision(9)
    expect(call).toHaveBeenCalledTimes(2)
  })

  it('answers with the built-in catalog while unpaired instead of calling the runtime', async () => {
    const call = vi.fn()
    const sync = createWebAgentCatalogSync({
      call,
      isPaired: () => false,
      onRevisionApplied: vi.fn()
    })

    expect((await sync.getLocal()).customAgents).toEqual([])
    expect(call).not.toHaveBeenCalled()
  })

  it('reports the oversize projection without inventing custom agents', () => {
    const snapshot = projectWebAgentCatalog({
      version: 1,
      revision: 12,
      code: 'agent_catalog_payload_too_large',
      maxBytes: 524_288
    })

    expect(snapshot.revision).toBe(12)
    expect(snapshot.customAgents).toEqual([])
    expect(snapshot.projection.status).toBe('too-large')
  })

  it('keeps a repair-required row visible without a local repair token', () => {
    const snapshot = projectWebAgentCatalog(
      hostSnapshot({
        customAgents: [
          {
            id: CUSTOM_ID,
            baseAgent: 'codex',
            label: null,
            status: 'repair-required',
            envState: 'none'
          }
        ]
      })
    )

    expect(snapshot.customAgents).toEqual([
      {
        status: 'repair-required',
        id: CUSTOM_ID,
        baseAgent: 'codex',
        label: null,
        repairToken: '',
        issues: [],
        rawBytes: 0,
        draftAvailability: 'too-large'
      }
    ])
  })
})
