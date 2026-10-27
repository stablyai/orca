import type { ProjectGroupingModel } from '../../../../shared/project-section-grouping'
import type { Project, ProjectHostSetup } from '../../../../shared/project-types'
import type { Repo } from '../../../../shared/repo-types'
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
 * The host (and setup) an entry's pane shows: the stored pick, while that host
 * still has a setup in this entry.
 */
export function getSettingsEntryHostSelection(
  settingsProject: SettingsProject,
  hostSelection: Readonly<Record<string, ExecutionHostId>>,
  setupSelection: Readonly<Record<string, string>>
): { hostId: ExecutionHostId | undefined; setupId: string | undefined } {
  const hostId = hostSelection[settingsProject.projectId]
  const setupId = setupSelection[settingsProject.projectId]
  return settingsProject.setups.some(
    (setup) => setup.hostId === hostId && (!setupId || setup.id === setupId)
  )
    ? { hostId, setupId }
    : { hostId: undefined, setupId: undefined }
}

/** Prefer local, then lowest repo ID, to keep navigation and pane identity stable until that repo is removed. */
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
 * One entry per project. Entries are derived from repos alone so the nav and
 * pane lists agree exactly.
 */
export function buildSettingsProjectList(
  repos: readonly Repo[],
  grouping?: ProjectGroupingModel
): SettingsProject[] {
  const projection = grouping
    ? { projects: grouping.projects, setups: grouping.projectHostSetups }
    : projectHostSetupProjectionFromRepos(repos)
  const projectById = new Map(projection.projects.map((project) => [project.id, project]))
  // Why: Settings metadata is rebuilt as repos refresh across hosts; index
  // setups once so many projects do not turn each refresh into an O(n²) scan.
  const entriesByProjectId = new Map<string, Omit<SettingsProject, 'representativeRepoId'>>()
  for (const setup of projection.setups) {
    const project = projectById.get(setup.projectId)
    if (!project) {
      continue
    }
    const entry = entriesByProjectId.get(project.id)
    if (entry) {
      entry.setups.push(setup)
    } else {
      entriesByProjectId.set(project.id, { projectId: project.id, project, setups: [setup] })
    }
  }
  return [...entriesByProjectId.values()].map((entry) => ({
    ...entry,
    representativeRepoId: getSettingsProjectRepresentativeRepoId(entry.setups)
  }))
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

/** Map host repo IDs to collapsed panes for repository deep links. */
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

/** Which entry, host and setup row a Settings deep link opens. */
export type SettingsProjectHostSelection = {
  projectId: string
  hostId: ExecutionHostId
  setupId: string
}

/** Resolve deep links to their exact setup: one host can own several (e.g. Windows + WSL clones). */
export function buildRepoIdToHostSelection(
  projects: readonly SettingsProject[]
): Map<string, SettingsProjectHostSelection> {
  const map = new Map<string, SettingsProjectHostSelection>()
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
): SettingsProjectHostSelection | null {
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

/** Repo IDs may contain hyphens; match known IDs longest-first in subsection links. */
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
 * Removes a Settings entry's setup on every host it exists on. Sequential so
 * each host's teardown + projection recompute don't interleave; setups without
 * a repo row (planned/not-set-up hosts) have nothing to remove.
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
      // Surface failures from user-initiated removal.
      await removeProject(setup.repoId, { hostId: setup.hostId, errorFeedback: 'toast' })
    }
  }
}

/** Keep pane rendering and hook loading on the same repo ID and host, including same-ID self-pairs. */
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
