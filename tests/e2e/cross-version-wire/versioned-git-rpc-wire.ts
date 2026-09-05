import {
  importReleaseCheckoutModule,
  materializeReleaseCheckout,
  type ReleaseCheckout
} from './release-checkout'

/**
 * Per-build Git RPC surface: method names and a dispatcher loaded from that
 * checkout, so "the old host does not register X" is a fact about a real release.
 * Does not load orca-runtime-git; status payloads stay host-stubbed.
 */

export const WORKING_TREE = 'working-tree' as const

export type RpcReply = {
  id: string
  ok: boolean
  streaming?: true
  result?: unknown
  error?: { code: string; message: string }
}

export type RpcClientIdentity = {
  clientKind?: 'mobile' | 'runtime'
  clientCapabilities?: readonly string[]
  connectionId?: string
  clientId?: string
}

export type GitRpcDispatcher = {
  dispatch: (
    request: { id: string; authToken: string; method: string; params?: unknown },
    options?: RpcClientIdentity
  ) => Promise<RpcReply>
}

export type GitRpcWireBuild = {
  /** Human label used in test names and failure messages. */
  label: string
  /** `working-tree` for current code, otherwise the resolved release commit. */
  revision: string
  /** RPC method names the build registers, read from source. */
  methodNames: readonly string[]
  createDispatcher: (runtime: unknown) => GitRpcDispatcher
}

type DispatcherModule = {
  RpcDispatcher: new (options: { runtime: unknown; methods: unknown[] }) => {
    dispatch: (
      request: { id: string; authToken: string; method: string; params?: unknown },
      options?: RpcClientIdentity
    ) => Promise<RpcReply>
  }
}

function registeredMethodNames(methods: readonly unknown[]): string[] {
  return methods
    .flatMap((method) => {
      if (!method || typeof method !== 'object') {
        return []
      }
      const name = Reflect.get(method, 'name')
      return typeof name === 'string' ? [name] : []
    })
    .sort()
}

async function loadWorkingTreeBuild(): Promise<GitRpcWireBuild> {
  const [dispatcher, methodRegistry] = await Promise.all([
    import('../../../src/main/runtime/rpc/dispatcher'),
    import('../../../src/main/runtime/rpc/methods')
  ])
  const module = dispatcher as unknown as DispatcherModule
  const methods = methodRegistry.ALL_RPC_METHODS as unknown[]
  return {
    label: WORKING_TREE,
    revision: WORKING_TREE,
    methodNames: registeredMethodNames(methods),
    createDispatcher: (runtime) =>
      new module.RpcDispatcher({
        runtime,
        methods
      })
  }
}

async function loadReleaseBuild(checkout: ReleaseCheckout): Promise<GitRpcWireBuild> {
  const [dispatcher, methodRegistry] = await Promise.all([
    importReleaseCheckoutModule(checkout, '/src/main/runtime/rpc/dispatcher.ts'),
    importReleaseCheckoutModule(checkout, '/src/main/runtime/rpc/methods/index.ts')
  ])
  const module = dispatcher as unknown as DispatcherModule
  const methods = methodRegistry.ALL_RPC_METHODS as unknown[]
  return {
    label: checkout.ref,
    revision: checkout.commit,
    methodNames: registeredMethodNames(methods),
    createDispatcher: (runtime) =>
      new module.RpcDispatcher({
        runtime,
        methods
      })
  }
}

/**
 * Load the Git RPC wire surface for one build. `WORKING_TREE` imports current
 * source; any other value is a git ref extracted into a cached checkout.
 */
export async function loadGitRpcWireBuild(ref: string): Promise<GitRpcWireBuild> {
  if (ref === WORKING_TREE) {
    return loadWorkingTreeBuild()
  }
  return loadReleaseBuild(await materializeReleaseCheckout(ref))
}

export function gitMethodNames(build: GitRpcWireBuild): string[] {
  return build.methodNames.filter((name) => name.startsWith('git.'))
}
