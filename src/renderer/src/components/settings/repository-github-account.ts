import type { GhAccountBinding } from '../../../../shared/github/account-binding'
import type { Repo } from '../../../../shared/repo-types'
import type {
  GhAccountBindingInventory,
  GhAccountBindingValidationResult
} from '../../../../shared/github/auth-types'
import { ghAccountBindingsEqual } from '../../../../shared/github/account-binding'
import { callRuntimeRpc, type getActiveRuntimeTarget } from '@/runtime/runtime-rpc-client'

type RuntimeTarget = ReturnType<typeof getActiveRuntimeTarget>

const LOCAL_GH_ACCOUNT_IPC_TIMEOUT_MS = 30_000

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = window.setTimeout(() => {
      reject(new Error(`${label} timed out after ${timeoutMs}ms`))
    }, timeoutMs)
    promise.then(
      (value) => {
        window.clearTimeout(timer)
        resolve(value)
      },
      (error: unknown) => {
        window.clearTimeout(timer)
        reject(error)
      }
    )
  })
}

/** Routes through RPC for remote environments and IPC locally; both read the repo's execution host. */
export function listRepositoryGhBindableAccounts(
  runtimeTarget: RuntimeTarget,
  repo: Repo,
  options: { refreshCapability?: boolean } = {}
): Promise<GhAccountBindingInventory> {
  if (runtimeTarget.kind === 'environment') {
    return callRuntimeRpc<GhAccountBindingInventory>(
      runtimeTarget,
      'github.listBindableAccounts',
      { repo: repo.id, refreshCapability: options.refreshCapability },
      { timeoutMs: LOCAL_GH_ACCOUNT_IPC_TIMEOUT_MS }
    )
  }
  return withTimeout(
    window.api.gh.listBindableAccounts({
      repoPath: repo.path,
      repoId: repo.id,
      refreshCapability: options.refreshCapability
    }),
    LOCAL_GH_ACCOUNT_IPC_TIMEOUT_MS,
    'listBindableAccounts'
  )
}

export function validateRepositoryGhAccountBinding(
  runtimeTarget: RuntimeTarget,
  repo: Repo,
  binding: GhAccountBinding
): Promise<GhAccountBindingValidationResult> {
  if (runtimeTarget.kind === 'environment') {
    return callRuntimeRpc<GhAccountBindingValidationResult>(
      runtimeTarget,
      'github.validateAccountBinding',
      { repo: repo.id, host: binding.host, user: binding.user },
      { timeoutMs: LOCAL_GH_ACCOUNT_IPC_TIMEOUT_MS }
    )
  }
  return withTimeout(
    window.api.gh.validateAccountBinding({
      repoPath: repo.path,
      repoId: repo.id,
      host: binding.host,
      user: binding.user
    }),
    LOCAL_GH_ACCOUNT_IPC_TIMEOUT_MS,
    'validateAccountBinding'
  )
}

/** False when an older remote runtime silently strips `ghAccount`, which the UI surfaces as "not enforced". */
export function isGhAccountBindingEnforced(
  requested: GhAccountBinding | null,
  echoed: Repo['ghAccount'] | null | undefined
): boolean {
  if (!requested) {
    return !echoed
  }
  return ghAccountBindingsEqual(requested, echoed ?? null)
}
