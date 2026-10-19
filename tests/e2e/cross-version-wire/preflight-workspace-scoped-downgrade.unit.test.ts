// Workspace-scoped agent detection, paired across two builds: current code against the newest
// published release.
//
// `preflight.detectAgents` / `refreshAgents` gained an optional `{ worktreeId }` so the host probes
// the workspace's own runtime (a WSL distro on a Windows host). Each skew must keep today's answer:
//
//  - an old client sends nothing, and a new host answers with its own default as it always did;
//  - a new client asks an old host only for its default, because the capability is absent — and an
//    old host that is sent the field anyway (mobile does not gate) discards it rather than refusing.
//
// The old side's capability list is read from its checkout and the capability removed from it, so
// this stays exercised after a release ships the capability.

import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  PREFLIGHT_WORKSPACE_SCOPED_RUNTIME_CAPABILITY,
  RUNTIME_CAPABILITIES
} from '../../../src/shared/protocol-version'
import { RPC_PARAMS_BY_METHOD } from '../../../src/shared/rpc-contract/rpc-params-catalog.generated'
import { parseRpcRequestParams } from '../../../src/main/runtime/rpc/dispatcher-request-parsing'
import type { RpcAnyMethodDeclaration, RpcRequest } from '../../../src/main/runtime/rpc/core'
import { getRuntimeAgentInventoryKey } from '../../../src/renderer/src/store/slices/runtime-agent-inventory-key'
import {
  importReleaseCheckoutModule,
  materializeReleaseCheckout,
  resolveBaselineReleaseRef
} from './release-checkout'

// Why: a cold CI run extracts the baseline checkout before the first pairing.
const SUITE_TIMEOUT_MS = 180_000
const WORKTREE = 'repo-1::\\\\wsl.localhost\\Ubuntu\\home\\me\\repo'

type ParseParams = (
  request: RpcRequest,
  method: Pick<RpcAnyMethodDeclaration, 'params'>,
  meta: unknown
) => { value?: unknown; error?: unknown }

type HostBuild = {
  capabilities: readonly string[]
  parse: (method: string, params: unknown) => unknown
}

const wire = vi.hoisted(() => {
  const state: {
    host: null | { capabilities: readonly string[]; parse: (m: string, p: unknown) => unknown }
    sent: { method: string; params: unknown; hostSaw: unknown }[]
  } = { host: null, sent: [] }
  return state
})

vi.mock('@/runtime/runtime-rpc-client', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  return {
    ...actual,
    runtimeEnvironmentSupportsCapability: async (_environmentId: string, capability: string) =>
      wire.host?.capabilities.includes(capability) ?? false,
    // Why linux: an old Windows host is asked to update instead of answering its default list.
    getRuntimeEnvironmentStatus: async () => ({
      capabilities: wire.host?.capabilities ?? [],
      hostPlatform: 'linux'
    }),
    callRuntimeRpc: async (_target: unknown, method: string, params?: unknown) => {
      const hostSaw = wire.host?.parse(method, params)
      wire.sent.push({ method, params, hostSaw })
      const scoped = typeof hostSaw === 'object' && hostSaw !== null && 'worktreeId' in hostSaw
      const agents = scoped ? ['claude', 'codex'] : ['claude']
      return method === 'preflight.refreshAgents' ? { agents } : agents
    }
  }
})

// @ts-expect-error -- minimal window.api stub for the store under test
globalThis.window = { api: {} }

const { createTestStore } =
  await import('../../../src/renderer/src/store/slices/store-test-helpers')

function member<T>(module: Record<string, unknown>, name: string): T {
  const value = module[name]
  if (value === undefined) {
    throw new Error(`the baseline release exports no ${name}`)
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a release module is typed unknown; the name is the same export this build calls, and a missing one throws above.
  return value as T
}

function hostBuild(
  capabilities: readonly string[],
  catalog: Record<string, unknown>,
  parse: ParseParams
): HostBuild {
  return {
    capabilities,
    parse: (method, params) => {
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: catalog entries are the Zod schema or null each build's dispatcher reads.
      const schema = (catalog[method] ?? null) as RpcAnyMethodDeclaration['params']
      const parsed = parse({ id: '1', authToken: 't', method, params }, { params: schema }, {})
      if (parsed.error) {
        throw new Error(`${method} refused ${JSON.stringify(params)}`)
      }
      return parsed.value
    }
  }
}

let oldHost: HostBuild
let newHost: HostBuild

beforeAll(async () => {
  const checkout = await materializeReleaseCheckout(resolveBaselineReleaseRef())
  const [protocol, catalog, parsing] = await Promise.all([
    importReleaseCheckoutModule(checkout, 'src/shared/protocol-version.ts'),
    importReleaseCheckoutModule(
      checkout,
      'src/shared/rpc-contract/rpc-params-catalog.generated.ts'
    ),
    importReleaseCheckoutModule(checkout, 'src/main/runtime/rpc/dispatcher-request-parsing.ts')
  ])
  const oldCatalog = member<Record<string, unknown>>(catalog, 'RPC_PARAMS_BY_METHOD')
  oldHost = hostBuild(
    member<readonly string[]>(protocol, 'RUNTIME_CAPABILITIES').filter(
      (capability) => capability !== PREFLIGHT_WORKSPACE_SCOPED_RUNTIME_CAPABILITY
    ),
    // Why null: once a release ships the schema, the old side must still be the pre-schema host.
    { ...oldCatalog, 'preflight.detectAgents': null, 'preflight.refreshAgents': null },
    member<ParseParams>(parsing, 'parseRpcRequestParams')
  )
  newHost = hostBuild(RUNTIME_CAPABILITIES, RPC_PARAMS_BY_METHOD, (request, method, meta) =>
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the parser only reads `params` from the declaration.
    parseRpcRequestParams(request, method as RpcAnyMethodDeclaration, meta as never)
  )
}, SUITE_TIMEOUT_MS)

beforeEach(() => {
  wire.sent.length = 0
})

describe('workspace-scoped agent detection across versions', () => {
  it('a new client asks an old host only for its default list', async () => {
    wire.host = oldHost
    const store = createTestStore()

    const detected = await store.getState().ensureRuntimeDetectedAgents('env-1', WORKTREE)
    const refreshed = await store.getState().refreshRuntimeDetectedAgents('env-1', WORKTREE)

    expect(wire.sent.map(({ method, params }) => ({ method, params }))).toEqual([
      { method: 'preflight.detectAgents', params: undefined },
      { method: 'preflight.refreshAgents', params: undefined }
    ])
    expect(detected).toEqual(['claude'])
    expect(refreshed).toEqual(['claude'])
    expect(
      store.getState().runtimeDetectedAgentIds[getRuntimeAgentInventoryKey('env-1', WORKTREE)]
    ).toEqual(['claude'])
  })

  it('an old host discards the field from an ungated client instead of refusing it', () => {
    expect(oldHost.parse('preflight.detectAgents', { worktreeId: WORKTREE })).toBeUndefined()
    expect(oldHost.parse('preflight.refreshAgents', { worktreeId: WORKTREE })).toBeUndefined()
  })

  it('a new client names the workspace to a new host', async () => {
    wire.host = newHost
    const store = createTestStore()

    expect(await store.getState().ensureRuntimeDetectedAgents('env-1', WORKTREE)).toEqual([
      'claude',
      'codex'
    ])
    expect(wire.sent).toEqual([
      {
        method: 'preflight.detectAgents',
        params: { worktreeId: WORKTREE },
        hostSaw: { worktreeId: WORKTREE }
      }
    ])
  })

  it('an old client gets the host default from a new host', async () => {
    wire.host = newHost
    for (const params of [undefined, null]) {
      expect(newHost.parse('preflight.detectAgents', params)).toEqual({})
      expect(newHost.parse('preflight.refreshAgents', params)).toEqual({})
    }
    // The host-default list keeps its environment-only key, which existing readers index by.
    const store = createTestStore()
    expect(await store.getState().ensureRuntimeDetectedAgents('env-1')).toEqual(['claude'])
    expect(wire.sent[0]?.params).toBeUndefined()
    expect(store.getState().runtimeDetectedAgentIds['env-1']).toEqual(['claude'])
  })
})
