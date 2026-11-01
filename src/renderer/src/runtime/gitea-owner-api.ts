import type { GiteaApi } from '../../../preload/api/gitea-api'
import { createRuntimeGiteaApi, type RuntimeGiteaTransport } from './runtime-gitea-api'
import { callRuntimeRpc } from './runtime-rpc-client'
import { RuntimeRpcCallError } from './runtime-rpc-result'
import { translate } from '@/i18n/i18n'
import { forgeCredentialTarget, type ForgeRepoSelector } from './forge-credential-target'

const GITEA_RPC_TIMEOUT_MS = 30_000

// Why: a task source names the repo by its id on the server that published it.
function withSourceRepo(params: unknown, sourceRepoId: string | null): unknown {
  return sourceRepoId && params && typeof params === 'object' && 'repo' in params
    ? { ...params, repo: `id:${sourceRepoId}` }
    : params
}

// Why: servers that predate Gitea answer method_not_found, which reads as an Orca bug without this.
function explainUnsupportedServer(error: unknown): never {
  if (error instanceof RuntimeRpcCallError && error.code === 'method_not_found') {
    throw new Error(
      translate(
        'codeHost.errors.gitea.serverUnsupported',
        'This Orca server does not support Gitea yet. Update the server to use Gitea here.'
      ),
      { cause: error }
    )
  }
  throw error
}

function runtimeGiteaApi(environmentId: string, sourceRepoId: string | null): GiteaApi {
  const target = { kind: 'environment', environmentId } as const
  return createRuntimeGiteaApi({
    call: <Result>(method: Parameters<RuntimeGiteaTransport['call']>[0], params?: unknown) =>
      callRuntimeRpc<Result>(target, method, withSourceRepo(params, sourceRepoId), {
        timeoutMs: GITEA_RPC_TIMEOUT_MS
      }).catch(explainUnsupportedServer)
  })
}

/** The `tea` API on the machine that holds the repo's Gitea credentials. */
export function giteaApiFor(selector?: ForgeRepoSelector): GiteaApi {
  if (!selector) {
    return window.api.gitea
  }
  let target: ReturnType<typeof forgeCredentialTarget>
  try {
    target = forgeCredentialTarget(selector)
  } catch (error) {
    // Why: callers chain `.then`/`await`; an unknown owner must reject, not throw synchronously.
    return createRuntimeGiteaApi({ call: () => Promise.reject(error) })
  }
  return target.kind === 'environment'
    ? runtimeGiteaApi(target.environmentId, selector.sourceContext?.repoId?.trim() || null)
    : window.api.gitea
}
