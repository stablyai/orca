import type { ProjectSectionEntry } from '../project-section-grouping'
import type { ProjectGroup } from '../project-group-types'
import type { Worktree } from '../worktree/types'
import type { RenderableFolderWorkspace } from './folder-workspace-lanes'

export type OrderedGroupEntry = [string, WorktreeGroupEntry]

export type WorktreeGroupEntry = ProjectSectionEntry<Worktree> & {
  /** Original dimension key when this entry is rendered under a qualified nested key. */
  sourceKey?: string
  projectGroup?: ProjectGroup
  /** Folder rows need their owning group even outside repo grouping. */
  folderWorkspaces?: RenderableFolderWorkspace[]
}
