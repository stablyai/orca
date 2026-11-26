// The repos this user configures from their own settings and pickers: a shared agent's host's repos
// load only for its workers' pages and stay its owner's to manage.
import { useMemo } from 'react'
import { useAppStore } from '@/store'
import { useSharedBotHosts } from '@/runtime/hosts/shared-bot-hosts/shared-bot-host-catalog'
import { userManagedRepos } from '../../../../shared/project/catalog/hidden-projects'
import type { Repo } from '../../../../shared/repository/repo-types'

export function useUserManagedRepos(): readonly Repo[] {
  const repos = useAppStore((state) => state.repos)
  // Followed so a share arriving or ending re-reads which hosts' repos are kept out.
  const shared = useSharedBotHosts()
  // oxlint-disable-next-line react-hooks/exhaustive-deps -- `shared` re-runs the read it changes.
  return useMemo(() => userManagedRepos(repos), [repos, shared])
}
