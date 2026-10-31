export {
  getSettingsEntryHostSelection,
  getSettingsProjectRemovalScope
} from './settings-project-host-selection'
import type { ProjectGroupingModel } from '../../../../shared/project-section-grouping'

import type { Repo } from '../../../../shared/repo-types'
import type { ProjectHostSetup } from '../../../../shared/project-types'
import type { SettingsConcreteSelection, SettingsProject } from './settings-project-types'

export type {
  SettingsProject,
  SettingsProjectRemovalScope,
  SettingsConcreteSelection
} from './settings-project-types'
import { buildProjectSetupRepoLookup } from '@/lib/project-setup-repo-lookup'
import { resolveQualifiedIndexedRepoOwnerForHost } from '@/lib/repo-owner-index'
import { getProjectRepoFilterHost } from '../../../../shared/project-repo-filter-selection'

import { type ExecutionHostId, LOCAL_EXECUTION_HOST_ID } from '../../../../shared/execution-host'
import { projectHostSetupProjectionFromRepos } from '../../../../shared/project-host-setup-projection'
import { buildProjectGroups } from '../../../../shared/project-grouping'

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

/** Settings and the sidebar use the same project membership. */
export function buildSettingsProjectList(
  repos: readonly Repo[],
  projectGrouping?: ProjectGroupingModel
): SettingsProject[] {
  const model =
    projectGrouping ??
    (() => {
      const projection = projectHostSetupProjectionFromRepos(repos)
      return { projects: projection.projects, projectHostSetups: projection.setups }
    })()
  const projectById = new Map(model.projects.map((project) => [project.id, project]))
  return buildProjectGroups(model).flatMap((group) => {
    const projectId = group.representative.projectId
    const project = projectById.get(projectId)
    if (!project) {
      return []
    }
    return [
      {
        projectId,
        selectionKey: group.key,
        project,
        setups: group.registrations,
        representativeRepoId: group.representative.repoId,
        representativeHostId: group.representative.hostId,
        ...(group.key.includes('::host:') ? { checkoutLabel: group.label, splitProject: true } : {})
      }
    ]
  })
}

/** Validate saved host selection against live setups; fall back to local, ready, then first. */
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
        if (!map.has(setup.repoId)) {
          map.set(setup.repoId, settingsProject.selectionKey)
        }
      }
    }
  }
  return map
}

/** Which entry, host and setup row a Settings deep link opens. */
export type SettingsProjectHostSelection = {
  selectionKey: string
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
          selectionKey: settingsProject.selectionKey,
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
  hostId: ExecutionHostId,
  selectionKey?: string,
  physicalHostId?: ExecutionHostId
): SettingsProjectHostSelection | null {
  for (const settingsProject of projects) {
    if (selectionKey && settingsProject.selectionKey !== selectionKey) {
      continue
    }
    const setup = settingsProject.setups.find(
      (candidate) =>
        candidate.repoId === repoId &&
        candidate.hostId === hostId &&
        (!physicalHostId || getProjectRepoFilterHost(candidate) === physicalHostId)
    )
    if (setup) {
      return { selectionKey: settingsProject.selectionKey, hostId, setupId: setup.id }
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

/** Remove sequentially to avoid interleaved teardown/projection updates; planned hosts have no repo to remove. */
export async function removeSettingsProjectFromAllHosts(
  setups: readonly ProjectHostSetup[],
  removeProject: (
    repoId: string,
    options: { hostId: ExecutionHostId; errorFeedback?: 'toast' | 'silent' }
  ) => Promise<void>
): Promise<void> {
  const seen = new Set<string>()
  for (const setup of setups) {
    const identity = `${setup.hostId}\0${setup.repoId}`
    if (setup.repoId.trim().length > 0 && !seen.has(identity)) {
      seen.add(identity)
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
  const setup = getSettingsProjectSelectedSetup(settingsProject, selectedHostId, selectedSetupId)
  if (!setup) {
    return undefined
  }
  const physical = getProjectRepoFilterHost(setup)
  const match = resolveQualifiedIndexedRepoOwnerForHost(
    repos,
    setup.repoId,
    setup.hostId,
    setup.hostId.startsWith('runtime:')
      ? physical.startsWith('ssh:')
        ? physical.slice(4)
        : null
      : undefined
  )
  return match.kind === 'resolved'
    ? match.owner
    : (() => {
        const candidates = buildProjectSetupRepoLookup(repos).byId.get(setup.repoId) ?? []
        const legacy = candidates.length === 1 ? candidates[0] : undefined
        return legacy && !legacy.executionHostId && !legacy.connectionId ? legacy : undefined
      })()
}

/** The same concrete selection supplies rendering and continuity, even without a hydrated Repo. */
export function getSettingsProjectSelectedSetup(
  entry: SettingsProject,
  hostId: ExecutionHostId | undefined,
  setupId?: string
): ProjectHostSetup | undefined {
  const host = resolveEffectiveProjectHost(entry.setups, hostId)
  return (
    entry.setups.find((setup) => setup.id === setupId && setup.hostId === host) ??
    entry.setups.find((setup) => setup.hostId === host) ??
    entry.setups[0]
  )
}

export function projectSettingsConcreteSelection(
  entries: readonly SettingsProject[],
  activeSectionId: string,
  anchor: SettingsConcreteSelection | null
): SettingsConcreteSelection | null {
  if (!anchor || anchor.sectionId !== activeSectionId) {
    return null
  }
  const current = entries.find((entry) => `repo-${entry.selectionKey}` === anchor.sectionId)
  const target = getSettingsTargetHostSelection(
    entries,
    anchor.repoId,
    anchor.hostId,
    current?.selectionKey,
    anchor.physicalHostId
  )
  if (!target) {
    return null
  }
  const entry = entries.find((candidate) => candidate.selectionKey === target.selectionKey)
  const setupId = entry?.setups.some(
    (setup) =>
      setup.id === anchor.setupId &&
      setup.hostId === anchor.hostId &&
      setup.repoId === anchor.repoId
  )
    ? anchor.setupId
    : target.setupId
  return { ...anchor, sectionId: `repo-${target.selectionKey}`, setupId }
}
