// Host-scoped workspace port scan and Stop, paired across two builds: current code against the
// newest published release.
//
// `workspacePorts.scanHost` / `killHost` are new methods, not new fields on `scan` / `kill`, because
// an old host would strip a host field and scan or signal on itself. Each skew must hold:
//
//  - an old client keeps calling `scan` / `kill` with `{ repoId }`, which a new host parses as before;
//  - an old host neither advertises the capability nor knows the methods, so a new client can only
//    get "update server" from it, never a scan or Stop of the wrong machine.
//
// The old side's capability list and catalog have the new entries removed, so this stays exercised
// after a release ships them.

import { beforeAll, describe, expect, it } from 'vitest'
import {
  RUNTIME_CAPABILITIES,
  WORKSPACE_PORTS_HOST_SCOPED_RUNTIME_CAPABILITY
} from '../../../src/shared/protocol-version'
import { RPC_PARAMS_BY_METHOD } from '../../../src/shared/rpc-contract/rpc-params-catalog.generated'
import { parseRpcRequestParams } from '../../../src/main/runtime/rpc/dispatcher-request-parsing'
import type { RpcAnyMethodDeclaration, RpcRequest } from '../../../src/main/runtime/rpc/core'
import {
  importReleaseCheckoutModule,
  materializeReleaseCheckout,
  resolveBaselineReleaseRef
} from './release-checkout'

// Why: a cold CI run extracts the baseline checkout before the first pairing.
const SUITE_TIMEOUT_MS = 180_000
const HOST_SCOPED_METHODS = ['workspacePorts.scanHost', 'workspacePorts.killHost']

type ParseParams = (
  request: RpcRequest,
  method: Pick<RpcAnyMethodDeclaration, 'params'>,
  meta: unknown
) => { value?: unknown; error?: unknown }

type HostBuild = {
  capabilities: readonly string[]
  knows: (method: string) => boolean
  parse: (method: string, params: unknown) => unknown
}

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
    knows: (method) => Object.hasOwn(catalog, method),
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
  const oldCatalog = Object.fromEntries(
    Object.entries(member<Record<string, unknown>>(catalog, 'RPC_PARAMS_BY_METHOD')).filter(
      ([method]) => !HOST_SCOPED_METHODS.includes(method)
    )
  )
  oldHost = hostBuild(
    member<readonly string[]>(protocol, 'RUNTIME_CAPABILITIES').filter(
      (capability) => capability !== WORKSPACE_PORTS_HOST_SCOPED_RUNTIME_CAPABILITY
    ),
    oldCatalog,
    member<ParseParams>(parsing, 'parseRpcRequestParams')
  )
  newHost = hostBuild(RUNTIME_CAPABILITIES, RPC_PARAMS_BY_METHOD, (request, method, meta) =>
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the parser only reads `params` from the declaration.
    parseRpcRequestParams(request, method as RpcAnyMethodDeclaration, meta as never)
  )
}, SUITE_TIMEOUT_MS)

describe('host-scoped workspace ports across versions', () => {
  it("an old client's endpoint scan and Stop parse the same on a new host", () => {
    for (const host of [oldHost, newHost]) {
      expect(host.parse('workspacePorts.scan', { repoId: 'repo-1' })).toEqual({ repoId: 'repo-1' })
      expect(host.parse('workspacePorts.kill', { repoId: 'repo-1', pid: 7, port: 3020 })).toEqual({
        repoId: 'repo-1',
        pid: 7,
        port: 3020
      })
    }
  })

  it('an old host offers a new client nothing to scan or stop another machine with', () => {
    expect(oldHost.capabilities).not.toContain(WORKSPACE_PORTS_HOST_SCOPED_RUNTIME_CAPABILITY)
    for (const method of HOST_SCOPED_METHODS) {
      expect(oldHost.knows(method)).toBe(false)
    }
  })

  it('a new host advertises the methods and requires the host a Stop was scanned on', () => {
    expect(newHost.capabilities).toContain(WORKSPACE_PORTS_HOST_SCOPED_RUNTIME_CAPABILITY)
    expect(newHost.parse('workspacePorts.scanHost', { worktree: 'id:repo-1::/srv/app' })).toEqual({
      worktree: 'id:repo-1::/srv/app'
    })
    expect(() =>
      newHost.parse('workspacePorts.killHost', { worktree: 'id:w', pid: 7, port: 3020 })
    ).toThrow(/refused/)
    expect(
      newHost.parse('workspacePorts.killHost', {
        worktree: 'id:w',
        executionHostId: 'ssh:box',
        pid: 7,
        port: 3020
      })
    ).toEqual({ worktree: 'id:w', executionHostId: 'ssh:box', pid: 7, port: 3020 })
  })
})
