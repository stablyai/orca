import type { Repo } from '../../../../shared/repo-types'
import type {
  RepositoryAddScriptPreview,
  RepositoryAddScriptRegistrationFields,
  RepositoryAddScriptRequest
} from '../../../../shared/repository-add-script-types'
import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'
import { callRuntimeRpc } from '../../runtime/runtime-rpc-client'
import { resolveRuntimeRepositoryAddScriptRequest } from '../../runtime/runtime-repository-add-script'

export type RegistrationClone = {
  request: RepositoryAddScriptRequest | undefined
  repo: Repo
  preview: RepositoryAddScriptPreview | undefined
}

const CLONE_TIMEOUT_MS = 10 * 60_000

/** Clones with this host's opt-in; the request stays undefined when an older server predates it. */
export async function cloneRepositoryWithAddScript(
  target: RuntimeClientTarget,
  url: string,
  destination: string
): Promise<RegistrationClone> {
  const request = await resolveRuntimeRepositoryAddScriptRequest(target)
  if (target.kind === 'local') {
    if (request) {
      const result = await window.api.repos.clone({
        url,
        destination,
        repositoryAddScriptPreview: request
      })
      return { request, repo: result.repo, preview: result.repositoryAddScriptPreview }
    }
    // Why: an explicit undefined arrives as an absent key, so the handler wraps nothing.
    const repo = await window.api.repos.clone({ url, destination })
    return { request, repo, preview: undefined }
  }
  const result = await callRuntimeRpc<{ repo: Repo } & RepositoryAddScriptRegistrationFields>(
    target,
    'repo.clone',
    { url, destination, ...(request ? { repositoryAddScriptPreview: request } : {}) },
    { timeoutMs: CLONE_TIMEOUT_MS }
  )
  return { request, repo: result.repo, preview: result.repositoryAddScriptPreview }
}
