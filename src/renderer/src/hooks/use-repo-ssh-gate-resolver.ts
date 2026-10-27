import { useCallback } from 'react'
import { useAppStore } from '@/store'
import { selectRepoSshGateInput } from '@/lib/repo-ssh-connection'
import type { Repo } from '../../../shared/repo-types'

export type RepoSshGateResolver = (repo: Repo) => ReturnType<typeof selectRepoSshGateInput>

/** Re-renders when either this client's or a paired server's SSH state changes. */
export function useRepoSshGateResolver(): RepoSshGateResolver {
  const sshConnectionStates = useAppStore((s) => s.sshConnectionStates)
  const sshStateByEnvironment = useAppStore((s) => s.sshStateByEnvironment)
  const runtimeStatusByEnvironmentId = useAppStore((s) => s.runtimeStatusByEnvironmentId)
  return useCallback(
    (repo: Repo) =>
      selectRepoSshGateInput(
        { sshConnectionStates, sshStateByEnvironment, runtimeStatusByEnvironmentId },
        repo
      ),
    [sshConnectionStates, sshStateByEnvironment, runtimeStatusByEnvironmentId]
  )
}
