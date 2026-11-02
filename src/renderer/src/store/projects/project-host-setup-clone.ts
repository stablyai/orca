import type { Repo } from '../../../../shared/repo-types'
import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'
import { callRuntimeRpc } from '../../runtime/rpc/calls/runtime-rpc-call'

export async function cloneProjectRepositoryOnHost(
  target: RuntimeClientTarget,
  url: string,
  destination: string,
  folderName?: string
): Promise<Repo> {
  return target.kind === 'local'
    ? window.api.repos.clone({ url, destination, folderName })
    : (
        await callRuntimeRpc<{ repo: Repo }>(
          target,
          'repo.clone',
          { url, destination, folderName },
          { timeoutMs: 10 * 60_000 }
        )
      ).repo
}
