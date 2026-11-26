// The repos this user configures from their own settings and pickers: a shared agent's host's repos
// load only for its workers' pages and stay its owner's to manage. The catalog is republished when
// shares change (shared-host-repo-catalog.ts), so keying on `repos` follows them.
import { useMemo } from 'react'
import { useAppStore } from '@/store'
import { userManagedRepos } from '../../../../shared/project/catalog/hidden-projects'
import type { Repo } from '../../../../shared/repository/repo-types'

export function useUserManagedRepos(): readonly Repo[] {
  const repos = useAppStore((state) => state.repos)
  return useMemo(() => userManagedRepos(repos), [repos])
}
