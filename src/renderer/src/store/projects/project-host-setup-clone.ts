import type { Repo } from '../../../../shared/repo-types'
import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'
import { callRuntimeRpc } from '../../runtime/runtime-rpc-client'

export async function cloneProjectRepositoryOnHost(
  target: RuntimeClientTarget,
  url: string,
  destination: string
): Promise<Repo> {
  return target.kind === 'local'
    ? window.api.repos.clone({ url, destination })
    : (
        await callRuntimeRpc<{ repo: Repo }>(
          target,
          'repo.clone',
          { url, destination },
          { timeoutMs: 10 * 60_000 }
        )
      ).repo
}
