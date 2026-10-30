// Pair a WSL-host orcad and the desktop across builds: the account env a newer desktop adds for a
// WSL host must reach an older orcad as params it accepts, and the Windows-drive refusal must read
// as a plain error to an older desktop while a newer desktop reads an older orcad's errors as before.
// Remove the capability from the released list so rolling releases cannot erase the downgrade case.

import { beforeAll, describe, expect, it } from 'vitest'
import { AGENT_SESSION_ACCOUNT_ENV_RUNTIME_CAPABILITY } from '../../../src/shared/agent-session-create-capabilities'
import { RUNTIME_CAPABILITIES } from '../../../src/shared/protocol-version'
import {
  readWslHostWindowsDriveRefusal,
  WslHostWindowsDriveRefusalError
} from '../../../src/shared/wsl-host-windows-drive-refusal'
import type { RpcAnyMethodDeclaration, RpcRequest } from '../../../src/main/runtime/rpc/core'
import { mapRuntimeError } from '../../../src/main/runtime/rpc/errors'
import {
  withWslOrcadAccountEnv,
  type WslOrcadAccountEnvDependencies
} from '../../../src/main/wsl/wsl-orcad-account-env'
import {
  RuntimeRpcCallError,
  unwrapRuntimeRpcResult
} from '../../../src/renderer/src/runtime/runtime-rpc-result'
import {
  importReleaseCheckoutModule,
  materializeReleaseCheckout,
  resolveBaselineReleaseRef,
  releaseModuleExport
} from './release-checkout'

const SUITE_TIMEOUT_MS = 180_000
const WSL_ENVIRONMENT = 'wsl:ubuntu'
const OPERATION_ID = `1793000000000-${'a'.repeat(32)}`
const CODEX_HOME = '/home/u/.orca/codex-b'

type ParseParams = (
  request: RpcRequest,
  method: Pick<RpcAnyMethodDeclaration, 'params'>,
  meta: unknown
) => { value?: unknown; error?: unknown }
type MapRuntimeError = typeof mapRuntimeError
type Unwrap = (response: unknown) => unknown

let olderHost: {
  capabilities: readonly string[]
  parse: (method: string, params: unknown) => unknown
  mapError: MapRuntimeError
}
let olderDesktopUnwrap: Unwrap

beforeAll(async () => {
  const checkout = await materializeReleaseCheckout(resolveBaselineReleaseRef())
  const [protocol, catalog, parsing, errors, result] = await Promise.all([
    importReleaseCheckoutModule(checkout, 'src/shared/protocol-version.ts'),
    importReleaseCheckoutModule(
      checkout,
      'src/shared/rpc-contract/rpc-params-catalog.generated.ts'
    ),
    importReleaseCheckoutModule(checkout, 'src/main/runtime/rpc/dispatcher-request-parsing.ts'),
    importReleaseCheckoutModule(checkout, 'src/main/runtime/rpc/errors.ts'),
    importReleaseCheckoutModule(checkout, 'src/renderer/src/runtime/runtime-rpc-result.ts')
  ])
  const oldCatalog = releaseModuleExport<Record<string, unknown>>(catalog, 'RPC_PARAMS_BY_METHOD')
  const parse = releaseModuleExport<ParseParams>(parsing, 'parseRpcRequestParams')
  olderHost = {
    capabilities: releaseModuleExport<readonly string[]>(protocol, 'RUNTIME_CAPABILITIES').filter(
      (capability) => capability !== AGENT_SESSION_ACCOUNT_ENV_RUNTIME_CAPABILITY
    ),
    parse: (method, params) => {
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: catalog entries are the Zod schema or null each build's dispatcher reads.
      const schema = (oldCatalog[method] ?? null) as RpcAnyMethodDeclaration['params']
      const parsed = parse({ id: '1', authToken: 't', method, params }, { params: schema }, {})
      if (parsed.error) {
        throw new Error(`${method} refused ${JSON.stringify(params)}`)
      }
      return parsed.value
    },
    mapError: releaseModuleExport<MapRuntimeError>(errors, 'mapRuntimeError')
  }
  olderDesktopUnwrap = releaseModuleExport<Unwrap>(result, 'unwrapRuntimeRpcResult')
}, SUITE_TIMEOUT_MS)

function accountDependencies(): WslOrcadAccountEnvDependencies {
  return {
    // A Codex launch never prepares a Claude account.
    prepareClaudeLaunch: async () => {
      throw new Error('unexpected Claude preparation')
    },
    claudeTerminalEnv: () => ({}),
    prepareCodexHome: async () => `\\\\wsl.localhost\\Ubuntu${CODEX_HOME.replaceAll('/', '\\')}`,
    managedAccountSelected: () => true,
    accountNotApplied: () => {}
  }
}

/** The params a newer desktop sends to the WSL host, given what that host advertises. */
async function sentByNewerDesktop(
  method: string,
  params: Record<string, unknown>,
  capabilities: readonly string[]
): Promise<unknown> {
  const routed = await withWslOrcadAccountEnv(
    {
      environmentId: WSL_ENVIRONMENT,
      method,
      params,
      hostSupports: async (capability) =>
        capabilities.includes(capability) ? 'supported' : 'unsupported'
    },
    accountDependencies(),
    (id) => (id === WSL_ENVIRONMENT ? 'Ubuntu' : null)
  )
  if (!routed.ok) {
    throw new Error(routed.message)
  }
  return routed.params
}

describe('a newer desktop and an older WSL-host orcad', () => {
  it('withholds the agent session account env the older orcad never advertised', async () => {
    const params = {
      clientOperationId: OPERATION_ID,
      worktree: 'path:/home/u/app',
      agent: 'codex'
    }
    const sent = await sentByNewerDesktop(
      'terminal.createAgentSession',
      params,
      olderHost.capabilities
    )
    expect(sent).toEqual(params)
    expect(olderHost.parse('terminal.createAgentSession', sent)).toMatchObject(params)
    // The current host advertises it, so the same desktop sends the home there.
    expect(
      await sentByNewerDesktop('terminal.createAgentSession', params, RUNTIME_CAPABILITIES)
    ).toEqual({ ...params, accountEnv: { CODEX_HOME } })
  })

  it('sends a terminal agent launch the older orcad accepts with its account home', async () => {
    const params = {
      agent: 'codex',
      target: { kind: 'existing', worktree: 'path:/home/u/app' }
    }
    const sent = await sentByNewerDesktop('agent.launch', params, olderHost.capabilities)
    expect(olderHost.parse('agent.launch', sent)).toMatchObject({
      ...params,
      accountEnv: { CODEX_HOME }
    })
  })

  it("reads the older orcad's failures as plain errors, with no drive refusal to act on", () => {
    const response = olderHost.mapError('req-1', { runtimeId: 'wsl-runtime' }, new Error('denied'))
    let thrown: unknown
    try {
      unwrapRuntimeRpcResult(response)
    } catch (error) {
      thrown = error
    }
    if (!(thrown instanceof RuntimeRpcCallError)) {
      throw new Error('expected the newer desktop to read a call error')
    }
    expect(thrown.message).toBe('denied')
    expect(readWslHostWindowsDriveRefusal(thrown.response.error.data)).toBeNull()
  })
})

describe('an older desktop and a newer WSL-host orcad', () => {
  it('shows the Windows-drive refusal as the readable runtime error it already handles', () => {
    const response = mapRuntimeError(
      'req-1',
      { runtimeId: 'wsl-runtime' },
      new WslHostWindowsDriveRefusalError('C:\\src\\app')
    )
    let thrown: unknown
    try {
      olderDesktopUnwrap(response)
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(Error)
    expect(thrown).toMatchObject({
      code: 'runtime_error',
      message: expect.stringContaining('This folder is on a Windows drive (C:\\src\\app).')
    })
  })
})
