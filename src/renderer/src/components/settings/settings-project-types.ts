import type { ExecutionHostId } from '../../../../shared/execution-host'
import type { ProjectHostSetup, Project } from '../../../../shared/project-types'

export type SettingsProject = {
  projectId: string
  project: Project
  setups: ProjectHostSetup[]
  representativeHostId: ExecutionHostId
  representativeRepoId: string
  /** Resolved group key used by this entry's host selection. */
  selectionKey: string
  /** Label for a host or folder group. */
  checkoutLabel?: string
  /** This entry holds a host or folder subset of its repository. */
  splitProject?: boolean
}

export type SettingsProjectRemovalScope = 'project' | 'checkout' | `host:${string}`

export type SettingsConcreteSelection = {
  sectionId: string
  repoId: string
  hostId: ExecutionHostId
  setupId: string
  physicalHostId?: ExecutionHostId
}
