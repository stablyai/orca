import type { Project, ProjectHostSetup } from '../../../../shared/project-types'
import type { Repo } from '../../../../shared/repo-types'
import { toRuntimeExecutionHostId } from '../../../../shared/execution-host'
import type { EphemeralVmWorkspaceRuntime } from '../slices/ephemeral-vm/ephemeral-vm-lifecycle'

type VmRuntimes = Readonly<Record<string, EphemeralVmWorkspaceRuntime>>

const cache = new WeakMap<
  readonly ProjectHostSetup[],
  WeakMap<VmRuntimes, WeakMap<readonly Repo[], readonly ProjectHostSetup[]>>
>()

/**
 * An Orca Cloud workspace's repo lives on its sandbox's runtime, and so does the setup that files it
 * under its project. While the sandbox is asleep (after a restart) the runtime's catalog never loads,
 * so the sidebar only has a placeholder repo named after the workspace folder, and the workspace
 * fell out of its project into a group of its own (RA-9). The local VM record still knows the
 * project it was started for: stand in a setup for it until the runtime answers with its own.
 */
export function withAsleepCloudProjectSetups(
  repos: readonly Repo[],
  projects: readonly Project[],
  setups: readonly ProjectHostSetup[],
  vmRuntimes: VmRuntimes | undefined
): readonly ProjectHostSetup[] {
  if (!vmRuntimes) {
    return setups
  }
  let byVm = cache.get(setups)
  if (!byVm) {
    byVm = new WeakMap()
    cache.set(setups, byVm)
  }
  let byRepos = byVm.get(vmRuntimes)
  if (!byRepos) {
    byRepos = new WeakMap()
    byVm.set(vmRuntimes, byRepos)
  }
  const cached = byRepos.get(repos)
  if (cached) {
    return cached
  }
  const result = computeStandIns(repos, projects, setups, vmRuntimes)
  byRepos.set(repos, result)
  return result
}

function computeStandIns(
  repos: readonly Repo[],
  projects: readonly Project[],
  setups: readonly ProjectHostSetup[],
  vmRuntimes: VmRuntimes
): readonly ProjectHostSetup[] {
  const setupRepoIds = new Set(setups.map((setup) => setup.repoId))
  const projectIds = new Set(projects.map((project) => project.id))
  const added: ProjectHostSetup[] = []
  for (const runtime of Object.values(vmRuntimes)) {
    if (!runtime.projectId || !runtime.runtimeEnvironmentId || !projectIds.has(runtime.projectId)) {
      continue
    }
    const repoId = runtime.workspaceId.split('::')[0]
    const hostId = toRuntimeExecutionHostId(runtime.runtimeEnvironmentId)
    const repo = repos.find((entry) => entry.id === repoId && entry.executionHostId === hostId)
    if (!repo || setupRepoIds.has(repoId)) {
      continue
    }
    setupRepoIds.add(repoId)
    added.push({
      id: `asleep-cloud:${repoId}`,
      projectId: runtime.projectId,
      hostId,
      repoId,
      path: repo.path,
      displayName: repo.displayName,
      executionHostId: hostId,
      setupState: 'ready',
      setupMethod: 'provisioned',
      createdAt: 0,
      updatedAt: 0
    })
  }
  return added.length > 0 ? [...setups, ...added] : setups
}
