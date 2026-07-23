import type { Project, ProjectHostSetup, Repo } from '../../../../shared/types'
import {
  getRepoExecutionHostId,
  LOCAL_EXECUTION_HOST_ID,
  type ExecutionHostId
} from '../../../../shared/execution-host'
import { projectHostSetupProjectionFromRepos } from '../../../../shared/project-host-setup-projection'

export type SettingsProject = {
  projectId: string
  project: Project
  setups: ProjectHostSetup[]
  representativeRepoId: string
}

/**
 * Which repo row identifies a project's single Settings nav row + pane. Pure
 * over the project's setups so nav and panes derive the same id. Prefers the
 * `local` host (the user's own machine) and otherwise the lowest repoId, so the
 * id is stable unless that exact repo row is removed.
 */
export function getSettingsProjectRepresentativeRepoId(
  setups: readonly ProjectHostSetup[]
): string {
  const localSetup = setups.find(
    (setup) => setup.hostId === LOCAL_EXECUTION_HOST_ID && setup.repoId.trim().length > 0
  )
  if (localSetup) {
    return localSetup.repoId
  }
  let lowest = ''
  for (const setup of setups) {
    const repoId = setup.repoId.trim()
    if (repoId.length > 0 && (lowest === '' || repoId < lowest)) {
      lowest = repoId
    }
  }
  return lowest
}

/**
 * Collapses repo rows into one entry per project so Settings renders per
 * project, matching the rest of the app. Derived from repos alone (not the
 * persisted projects/setups) so the nav and pane lists agree exactly.
 */
export function buildSettingsProjectList(repos: readonly Repo[]): SettingsProject[] {
  const projection = projectHostSetupProjectionFromRepos(repos)
  const setupsByProjectId = new Map<string, ProjectHostSetup[]>()
  for (const setup of projection.setups) {
    const projectSetups = setupsByProjectId.get(setup.projectId)
    if (projectSetups) {
      projectSetups.push(setup)
    } else {
      setupsByProjectId.set(setup.projectId, [setup])
    }
  }
  return projection.projects.map((project) => {
    // Why: Settings metadata is rebuilt as repos refresh across hosts; index
    // setups once so many projects do not turn each refresh into an O(n²) scan.
    const setups = setupsByProjectId.get(project.id) ?? []
    return {
      projectId: project.id,
      project,
      setups,
      representativeRepoId: getSettingsProjectRepresentativeRepoId(setups)
    }
  })
}

/**
 * The host whose settings the project pane should show. Validates the stored
 * selection against the live setups so a disconnected/removed host never leaves
 * the pane rendering off a dangling hostId: falls back to local, then the first
 * ready setup, then the first setup.
 */
export function resolveEffectiveProjectHost(
  setups: readonly ProjectHostSetup[],
  selectedHostId: ExecutionHostId | undefined
): ExecutionHostId | undefined {
  if (setups.length === 0) {
    return undefined
  }
  if (selectedHostId && setups.some((setup) => setup.hostId === selectedHostId)) {
    return selectedHostId
  }
  const localSetup = setups.find((setup) => setup.hostId === LOCAL_EXECUTION_HOST_ID)
  if (localSetup) {
    return localSetup.hostId
  }
  const readySetup = setups.find((setup) => setup.setupState === 'ready')
  return (readySetup ?? setups[0]).hostId
}

/** Maps every host's repoId to its project's representative repoId, so a
 *  `{pane:'repo', repoId}` deep link resolves to the collapsed pane. */
export function buildRepoIdToRepresentative(
  projects: readonly SettingsProject[]
): Map<string, string> {
  const map = new Map<string, string>()
  for (const settingsProject of projects) {
    for (const setup of settingsProject.setups) {
      if (setup.repoId.trim().length > 0) {
        map.set(setup.repoId, settingsProject.representativeRepoId)
      }
    }
  }
  return map
}

/** Maps each host's repoId to its owning project + host, so a deep link can
 *  select that host in the pane's "Available Hosts" switcher. */
export function buildRepoIdToHostSelection(
  projects: readonly SettingsProject[]
): Map<string, { projectId: string; hostId: ExecutionHostId }> {
  const map = new Map<string, { projectId: string; hostId: ExecutionHostId }>()
  for (const settingsProject of projects) {
    for (const setup of settingsProject.setups) {
      if (setup.repoId.trim().length > 0 && !map.has(setup.repoId)) {
        map.set(setup.repoId, { projectId: settingsProject.projectId, hostId: setup.hostId })
      }
    }
  }
  return map
}

/**
 * The repo row a Settings deep link points at, from either an explicit repoId
 * or a `repo-<id>-<subsection>` sectionId. repo ids can contain hyphens, so the
 * sectionId is matched against known ids with the longest match winning.
 */
export function resolveSettingsTargetRepoId(
  target: { repoId: string | null; sectionId?: string },
  repoIds: Iterable<string>
): string | null {
  if (target.repoId) {
    return target.repoId
  }
  const sectionId = target.sectionId
  if (!sectionId || !sectionId.startsWith('repo-')) {
    return null
  }
  let best: string | null = null
  for (const repoId of repoIds) {
    if (sectionId === `repo-${repoId}` || sectionId.startsWith(`repo-${repoId}-`)) {
      if (best === null || repoId.length > best.length) {
        best = repoId
      }
    }
  }
  return best
}

/**
 * Removes a project's setup on every host it exists on. Sequential so each
 * host's teardown + projection recompute don't interleave; setups without a
 * repo row (planned/not-set-up hosts) have nothing to remove.
 */
export async function removeSettingsProjectFromAllHosts(
  setups: readonly ProjectHostSetup[],
  removeProject: (repoId: string, options: { hostId: ExecutionHostId }) => Promise<void>
): Promise<void> {
  for (const setup of setups) {
    if (setup.repoId.trim().length > 0) {
      await removeProject(setup.repoId, { hostId: setup.hostId })
    }
  }
}

/**
 * The repo row the project pane should render for the given host selection.
 * Shared by the pane and the hooks-loading effect so they always agree on which
 * host's repo (id + host) is mounted — critical in the same-id/self-pair case.
 */
export function getSettingsProjectHostRepo(
  settingsProject: SettingsProject,
  repos: readonly Repo[],
  selectedHostId: ExecutionHostId | undefined,
  selectedSetupId?: string
): Repo | undefined {
  const effectiveHostId = resolveEffectiveProjectHost(settingsProject.setups, selectedHostId)
  if (!effectiveHostId) {
    return undefined
  }
  const effectiveSetup =
    settingsProject.setups.find(
      (setup) => setup.id === selectedSetupId && setup.hostId === effectiveHostId
    ) ??
    settingsProject.setups.find((setup) => setup.hostId === effectiveHostId) ??
    settingsProject.setups[0]
  return (
    repos.find(
      (repo) =>
        repo.id === effectiveSetup.repoId && getRepoExecutionHostId(repo) === effectiveHostId
    ) ??
    repos.find((repo) => repo.id === effectiveSetup.repoId) ??
    repos.find((repo) => repo.id === settingsProject.representativeRepoId)
  )
}
