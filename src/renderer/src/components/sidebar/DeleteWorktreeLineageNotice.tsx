import { Workflow } from 'lucide-react'
import { useMemo, type JSX } from 'react'
import type { Repo } from '../../../../shared/repo-types'
import { useAppStore } from '@/store'
import {
  buildProjectGroupingIndex,
  getProjectGroupingForRepo
} from '../../../../shared/project-section-grouping'
import type { Worktree } from '../../../../shared/worktree/types'
import { getWorktreeHostIdentity } from '../../../../shared/worktree/host-qualified-identity'
import { DeleteWorktreeDirtyChangeHint } from './DeleteWorktreeDirtyChangeHint'
import type {
  DeleteWorktreeChangeCheckState,
  DeleteWorktreeDirtyChangePreview
} from './delete-worktree-dirty-change-counts'
import { translate } from '@/i18n/i18n'

type DeleteWorktreeLineageNoticeProps = {
  descendants: readonly Worktree[]
  parent?: Worktree | null
  repoMap?: Map<string, Repo>
  dirtyChangeCountsByWorktreeId: ReadonlyMap<string, number>
  dirtyChangePreviewsByWorktreeId: ReadonlyMap<string, DeleteWorktreeDirtyChangePreview>
  changeCheckStatesByWorktreeId?: ReadonlyMap<string, DeleteWorktreeChangeCheckState>
}

export function DeleteWorktreeLineageNotice({
  descendants,
  parent,
  repoMap,
  dirtyChangeCountsByWorktreeId,
  dirtyChangePreviewsByWorktreeId,
  changeCheckStatesByWorktreeId
}: DeleteWorktreeLineageNoticeProps): JSX.Element | null {
  const projects = useAppStore((s) => s.projects)
  const projectHostSetups = useAppStore((s) => s.projectHostSetups)
  const projectIndex = useMemo(
    () =>
      buildProjectGroupingIndex({
        projects: projects ?? [],
        projectHostSetups: projectHostSetups ?? []
      }),
    [projects, projectHostSetups]
  )
  const projectLabels = new Map<string, string>()
  if (parent && repoMap) {
    const parentGroup = getProjectGroupingForRepo(parent.repoId, repoMap, projectIndex)
    for (const child of descendants) {
      const childGroup = getProjectGroupingForRepo(child.repoId, repoMap, projectIndex)
      if (childGroup.key !== parentGroup.key) {
        projectLabels.set(child.id, childGroup.label)
      }
    }
  }
  const foreignProjects = [...new Set(projectLabels.values())]
  const childWorkspaceCount = descendants.length
  if (childWorkspaceCount === 0) {
    return null
  }

  return (
    <div className="min-w-0 max-w-full overflow-hidden rounded-md border border-border/70 bg-muted/35 px-3 py-2 text-xs">
      <div className="flex items-start gap-2">
        <Workflow className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
        <div className="min-w-0 flex-1">
          <div className="font-medium text-foreground">
            {translate(
              'auto.components.sidebar.DeleteWorktreeLineageNotice.a940f3c96e',
              'Child workspaces will be deleted'
            )}
          </div>
          <div className="mt-1 text-muted-foreground">
            {translate(
              'auto.components.sidebar.DeleteWorktreeLineageNotice.alsoDeletesChildren',
              'Deleting this workspace also deletes {{count}} child workspaces.',
              {
                count: childWorkspaceCount,
                defaultValue_one: 'Deleting this workspace also deletes {{count}} child workspace.'
              }
            )}
            {foreignProjects.length > 0 ? ` (${foreignProjects.join(', ')})` : null}
          </div>
          {/* Constrain grid min-content width so nowrap paths cannot widen the modal. */}
          <div className="mt-2 min-w-0 max-w-full space-y-1 overflow-hidden rounded-sm border border-border/60 bg-background/60 px-2 py-1.5">
            {descendants.slice(0, 4).map((child) => (
              <div key={child.id} className="min-w-0 overflow-hidden">
                <div className="truncate font-medium text-foreground">
                  {child.displayName}
                  {projectLabels.has(child.id) ? (
                    <span className="text-muted-foreground"> · {projectLabels.get(child.id)}</span>
                  ) : null}
                </div>
                <div className="truncate text-muted-foreground">{child.path}</div>
                <DeleteWorktreeDirtyChangeHint
                  checkState={changeCheckStatesByWorktreeId?.get(
                    child.hostId ? getWorktreeHostIdentity(child) : child.id
                  )}
                  changeCount={dirtyChangeCountsByWorktreeId.get(
                    child.hostId ? getWorktreeHostIdentity(child) : child.id
                  )}
                  preview={dirtyChangePreviewsByWorktreeId.get(
                    child.hostId ? getWorktreeHostIdentity(child) : child.id
                  )}
                />
              </div>
            ))}
            {descendants.length > 4 ? (
              <div className="text-muted-foreground">
                {translate(
                  'auto.components.sidebar.DeleteWorktreeLineageNotice.moreChildren',
                  '+{{count}} more',
                  { count: descendants.length - 4, defaultValue_one: '+{{count}} more' }
                )}
              </div>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  )
}
