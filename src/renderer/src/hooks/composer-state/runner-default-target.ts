import { useEffect, useMemo, useState } from 'react'
import type { ExecutionHostId, ExecutionHostScope } from '../../../../shared/execution-host'
import { ALL_EXECUTION_HOSTS_SCOPE, parseExecutionHostId } from '../../../../shared/execution-host'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import type { LocalCapacitySignal } from '../../../../shared/local-capacity-signal-types'
import { runtimeHostContactForEntry } from '../../../../shared/runtime-host-contact'
import type { RuntimeEnvironmentStatus } from '../../../../shared/runtime-host-status'
import type { SshConnectionState } from '../../../../shared/ssh-types'
import { suggestDefaultRunTarget } from '@/lib/default-run-target-suggestion'
import type {
  LocalCapacityCause,
  RemoteServerRunTargetCandidate,
  SshRunTargetCandidate
} from '@/lib/default-run-target-suggestion'
import type { ProjectHostSetupOption } from '@/lib/project-host-setup-options'
import {
  resolveWorkspaceCreationTarget,
  type WorkspaceCreationTargetResolution
} from '@/lib/project-host-workspace-target'
import type { Project, ProjectHostSetup } from '../../../../shared/project-types'
import type { Repo } from '../../../../shared/repo-types'

type RunnerDefaultTargetInput = {
  settings: GlobalSettings | null
  /** Run-target options for the project being created into; only its ready rows are runners. */
  hostOptions: readonly ProjectHostSetupOption[]
  sshConnectionStates: ReadonlyMap<string, SshConnectionState>
  runtimeStatusByEnvironmentId: ReadonlyMap<string, RuntimeEnvironmentStatus>
  selectedProjectHostSetupOverrideId: string | null
  workspaceHostScope: ExecutionHostScope
  /** What creation resolves to before any suggestion; its project and repo are the ones kept. */
  baseTarget: WorkspaceCreationTargetResolution
  eligibleRepos: readonly Repo[]
  projects: readonly Project[]
  projectHostSetups: readonly ProjectHostSetup[]
  repoId: string
  actionableHostIds?: ReadonlySet<ExecutionHostId>
}

/**
 * A weak machine's default run target: the base resolution, moved to a healthy runner when the
 * setting allows and the user has not named a target themselves.
 *
 * `causes` is set only when the suggestion is what chose the target — a fallback that happened to
 * land on the same host is not a suggestion, and saying so would claim credit for the user's own
 * or the existing default's choice.
 */
export function useRunnerDefaultTarget(input: RunnerDefaultTargetInput): {
  target: WorkspaceCreationTargetResolution
  causes: LocalCapacityCause[] | null
} {
  const {
    settings,
    hostOptions,
    sshConnectionStates,
    runtimeStatusByEnvironmentId,
    selectedProjectHostSetupOverrideId,
    workspaceHostScope,
    baseTarget,
    eligibleRepos,
    projects,
    projectHostSetups,
    repoId,
    actionableHostIds
  } = input

  // Why: capacity is sampled on demand per composer — a stale answer is fine, an interval is not.
  const preferRunnerWhenLocalWeak = settings?.preferRunnerWhenLocalWeak === true

  const [localCapacitySignal, setLocalCapacitySignal] = useState<LocalCapacitySignal | null>(null)

  useEffect(() => {
    if (!preferRunnerWhenLocalWeak) {
      setLocalCapacitySignal(null)
      return
    }
    // Why: optional calls — a test harness can stub window.api partially, and no bridge is not a crash.
    const signalRead = window.api?.notifications?.getLocalCapacitySignal?.()
    if (!signalRead) {
      return
    }
    let cancelled = false
    // Why: an unreadable sample is "no capacity reason", never a routing decision of its own.
    void signalRead
      .then((signal) => {
        if (!cancelled) {
          setLocalCapacitySignal(signal)
        }
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [preferRunnerWhenLocalWeak])

  const candidates = useMemo(() => {
    const remoteServerCandidates: RemoteServerRunTargetCandidate[] = []
    const sshCandidates: SshRunTargetCandidate[] = []
    for (const option of hostOptions) {
      if (option.kind !== 'ready') {
        continue
      }
      const parsedHost = parseExecutionHostId(option.hostId)
      if (parsedHost?.kind === 'runtime') {
        remoteServerCandidates.push({
          hostId: option.hostId,
          contact: runtimeHostContactForEntry(
            runtimeStatusByEnvironmentId.get(parsedHost.environmentId)
          )
        })
      } else if (parsedHost?.kind === 'ssh') {
        sshCandidates.push({
          hostId: option.hostId,
          status: sshConnectionStates.get(parsedHost.targetId)?.status ?? null
        })
      }
    }
    return { remoteServerCandidates, sshCandidates }
  }, [hostOptions, runtimeStatusByEnvironmentId, sshConnectionStates])

  const suggestion = useMemo(() => {
    // Why: an explicit run target and a focused host scope are user choices; the suggestion only
    // fills the gap just before the blind "first ready setup" fallback.
    if (selectedProjectHostSetupOverrideId || workspaceHostScope !== ALL_EXECUTION_HOSTS_SCOPE) {
      return null
    }
    return suggestDefaultRunTarget({
      signal: localCapacitySignal,
      preferRunnerWhenLocalWeak,
      ...candidates
    })
  }, [
    candidates,
    localCapacitySignal,
    preferRunnerWhenLocalWeak,
    selectedProjectHostSetupOverrideId,
    workspaceHostScope
  ])

  return useMemo(() => {
    if (
      !suggestion ||
      baseTarget.status !== 'ready' ||
      baseTarget.target.hostId === suggestion.hostId
    ) {
      return { target: baseTarget, causes: null }
    }
    const base = baseTarget.target
    const routed = resolveWorkspaceCreationTarget({
      eligibleRepos,
      projects,
      projectHostSetups,
      draftRepoId: repoId,
      // Why: the project is what the composer is creating into; switching hosts must not switch it.
      projectId: base.projectId,
      hostId: suggestion.hostId,
      focusedHostScope: workspaceHostScope,
      actionableHostIds
    })
    // Why: the routed host may be set up for a different repo of the same project; switching the
    // composer's repo behind the user's back is worse than leaving the target where it was.
    if (routed.status !== 'ready' || routed.target.repoId !== base.repoId) {
      return { target: baseTarget, causes: null }
    }
    return { target: routed, causes: suggestion.causes }
  }, [
    actionableHostIds,
    baseTarget,
    eligibleRepos,
    projectHostSetups,
    projects,
    repoId,
    suggestion,
    workspaceHostScope
  ])
}
