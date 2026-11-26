// The repos this user configures from their own settings and pickers: a shared agent's host's repos
// load only for its workers' pages and stay its owner's to manage.
import { useMemo } from 'react'
import { useAppStore } from '@/store'
import { useSharedBotHosts } from '@/runtime/hosts/shared-bot-hosts/shared-bot-host-catalog'
import { userManagedRepos } from '../../../../shared/project/catalog/hidden-projects'
import { toRuntimeExecutionHostId } from '../../../../shared/execution-host/execution-host'
import type { Repo } from '../../../../shared/repository/repo-types'

export function useUserManagedRepos(): readonly Repo[] {
  const repos = useAppStore((state) => state.repos)
  const shared = useSharedBotHosts()
  const hosts = useMemo(
    () => new Set(shared.map((host) => toRuntimeExecutionHostId(host.environmentId))),
    [shared]
  )
  return useMemo(() => userManagedRepos(repos, hosts), [repos, hosts])
}
