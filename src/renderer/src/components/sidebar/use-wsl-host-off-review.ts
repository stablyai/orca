import { useAppStore } from '@/store'
import { getRepoExecutionHostId, parseExecutionHostId } from '../../../../shared/execution-host'
import type { Repo } from '../../../../shared/repo-types'
import { isWslHostOffForForge } from '@/store/github/wsl-host-off-forge'

/** E9: the repo's WSL host is off, so its review badges show the last known status. */
export function useWslHostOffForRepo(
  repo: Pick<Repo, 'executionHostId' | 'connectionId'> | undefined
): boolean {
  return useAppStore((state) => {
    const host = repo ? parseExecutionHostId(getRepoExecutionHostId(repo)) : null
    return host?.kind === 'runtime' && isWslHostOffForForge(state, host.environmentId)
  })
}
