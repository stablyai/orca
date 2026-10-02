import type { Project, ProjectHostSetup } from '../../../../shared/project-types'
import type { Repo } from '../../../../shared/repo-types'
import {
  getRepoExecutionHostId,
  LOCAL_EXECUTION_HOST_ID,
  type ExecutionHostId
} from '../../../../shared/execution-host'
import { projectHostSetupProjectionFromRepos } from '../../../../shared/project-host-setup-projection'
import {
  buildProjectGroupingIndex,
  getProjectGroupingForRepo
} from '../sidebar/worktree-list/grouping/project-grouping'

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
 * One Settings entry per checkout group: a project on multiple hosts collapses to
 * one entry, but a project with 2+ distinct checkouts sharing a host splits into one
 * entry per checkout — mirroring the sidebar's per-checkout rows so both stay in sync
 * and each clone gets its own nav row + editable pane (#18493). Grouping reuses the
 * sidebar's `getProjectGroupingForRepo`; `projectId` stays the merged project id (split
 * siblings self-scope via their singleton `setups`, so shared selection state is benign).
 * Derived from repos alone so the nav and pane lists agree exactly.
 */
export function buildSettingsProjectList(repos: readonly Repo[]): SettingsProject[] {
  const projection = projectHostSetupProjectionFromRepos(repos)
  const repoMap = new Map(repos.map((repo) => [repo.id, repo]))
  const projectById = new Map(projection.projects.map((project) => [project.id, project]))
  const groupingIndex = buildProjectGroupingIndex({
    projects: projection.projects,
    projectHostSetups: projection.setups
  })
  const groups = new Map<string, { project: Project; setups: ProjectHostSetup[] }>()
  const order: string[] = []
  for (const setup of projection.setups) {
    const project = projectById.get(setup.projectId)
    if (!project) {
      continue
    }
    // Same grouping decision the sidebar makes, so a checkout that gets its own
    // sidebar row also gets its own Settings entry (and vice versa).
    const groupKey = getProjectGroupingForRepo(setup.repoId, repoMap, groupingIndex).key
    const existing = groups.get(groupKey)
    if (existing) {
      existing.setups.push(setup)
    } else {
      groups.set(groupKey, { project, setups: [setup] })
      order.push(groupKey)
    }
  }
  return order.map((groupKey) => {
    const { project, setups } = groups.get(groupKey)!
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

/** Maps each host's repoId to its owning project + host + setup, so a deep link
 *  selects that exact checkout — critical when 2+ checkouts share one host, where
 *  hostId alone would collapse to the first setup and target the wrong repo (#18493). */
export function buildRepoIdToHostSelection(
  projects: readonly SettingsProject[]
): Map<string, { projectId: string; hostId: ExecutionHostId; setupId: string }> {
  const map = new Map<string, { projectId: string; hostId: ExecutionHostId; setupId: string }>()
  for (const settingsProject of projects) {
    for (const setup of settingsProject.setups) {
      if (setup.repoId.trim().length > 0 && !map.has(setup.repoId)) {
        map.set(setup.repoId, {
          projectId: settingsProject.projectId,
          hostId: setup.hostId,
          setupId: setup.id
        })
      }
    }
  }
  return map
}

export function getSettingsTargetHostSelection(
  projects: readonly SettingsProject[],
  repoId: string,
  hostId: ExecutionHostId
): { projectId: string; hostId: ExecutionHostId; setupId: string } | null {
  for (const settingsProject of projects) {
    const setup = settingsProject.setups.find(
      (candidate) => candidate.repoId === repoId && candidate.hostId === hostId
    )
    if (setup) {
      return { projectId: settingsProject.projectId, hostId, setupId: setup.id }
    }
  }
  return null
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
  removeProject: (
    repoId: string,
    options: { hostId: ExecutionHostId; errorFeedback?: 'toast' | 'silent' }
  ) => Promise<void>
): Promise<void> {
  for (const setup of setups) {
    if (setup.repoId.trim().length > 0) {
      // Why: user-initiated single-project removal, so a failure must be visible rather than silent (#11994).
      await removeProject(setup.repoId, { hostId: setup.hostId, errorFeedback: 'toast' })
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
