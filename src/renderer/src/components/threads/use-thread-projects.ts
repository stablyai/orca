import { useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useAppStore } from '@/store'
import { selectWorktreesByRepo } from '@/store/workspace-record-selectors'
import { lastVerifiedRuntimeStatus } from '../../../../shared/runtime-host-status'
import {
  readLocalRuntimeCapabilitiesOrUnknown,
  subscribeLocalRuntimeCapabilityObservation
} from '@/runtime/local-runtime-capabilities'
import { getRuntimeEnvironmentRevision } from '@/runtime/runtime-environment-revision'
import {
  threadProjectCandidates,
  supportedThreadProjects,
  type ThreadProject
} from './thread-projects'

const subscribeToNothing = () => () => {}
export function useThreadProjects(): { projects: ThreadProject[]; loading: boolean } {
  const [
    repos,
    worktreesByRepo,
    folderWorkspaces,
    projectGroups,
    lastVisitedAtByWorktreeId,
    activeWorktreeId,
    activeWorkspaceExecutionHostId
  ] = useAppStore(
    useShallow(
      (state) =>
        [
          state.repos,
          selectWorktreesByRepo(state),
          state.folderWorkspaces,
          state.projectGroups,
          state.lastVisitedAtByWorktreeId,
          state.activeWorktreeId,
          state.activeWorkspaceExecutionHostId
        ] as const
    )
  )
  const candidates = useMemo(
    () =>
      threadProjectCandidates({
        repos,
        worktreesByRepo,
        folderWorkspaces,
        projectGroups,
        lastVisitedAtByWorktreeId,
        activeWorktreeId,
        activeWorkspaceExecutionHostId
      }),
    [
      repos,
      worktreesByRepo,
      folderWorkspaces,
      projectGroups,
      lastVisitedAtByWorktreeId,
      activeWorktreeId,
      activeWorkspaceExecutionHostId
    ]
  )
  const hosts = useMemo(() => [...new Set(candidates.map((p) => p.hostId))], [candidates])
  const remoteGeneration = useAppStore((state) =>
    JSON.stringify(
      hosts.flatMap((host) => {
        if (!host.startsWith('runtime:')) {
          return []
        }
        const id = host.slice(8)
        const entry = state.runtimeStatusByEnvironmentId.get(id)
        const verified = lastVerifiedRuntimeStatus(entry)
        return [
          [
            id,
            getRuntimeEnvironmentRevision(id),
            entry?.hostContactEpoch,
            entry?.connectionGeneration,
            verified?.runtimeId,
            verified?.capabilities
          ]
        ]
      })
    )
  )
  const local = hosts.includes('local')
  const localGeneration = useSyncExternalStore(
    local ? subscribeLocalRuntimeCapabilityObservation : subscribeToNothing,
    () => (local ? readLocalRuntimeCapabilitiesOrUnknown() : null),
    () => null
  )
  const generation = useMemo(
    () => ({ candidates, remoteGeneration, localGeneration }),
    [candidates, remoteGeneration, localGeneration]
  )
  const [result, setResult] = useState<{ generation: object; projects: ThreadProject[] } | null>(
    null
  )
  useEffect(() => {
    let active = true
    void supportedThreadProjects(candidates).then((projects) => {
      if (active) {
        setResult({ generation, projects })
      }
    })
    return () => {
      active = false
    }
  }, [generation, candidates])
  return { projects: result?.projects ?? [], loading: result === null }
}
