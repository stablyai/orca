import React, { useMemo } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import { selectWorktreesByRepo } from '@/store/workspace-record-selectors'
import WorktreeCard from '../sidebar/WorktreeCard'
import { pickCardStudioGallery } from './card-studio-gallery-states'

/** Live cards for real workspaces in different states, drawn at the sidebar's width. Inert:
 *  pressing a preview never activates, renames or drags the workspace. */
export function CardStudioGallery(): React.JSX.Element {
  const focusedWorktreeId = useAppStore((s) => s.cardStudioWorktreeId)
  const sidebarWidth = useAppStore((s) => s.sidebarWidth)
  const inputs = useAppStore(
    useShallow((s) => ({
      worktreesByRepo: selectWorktreesByRepo(s),
      repos: s.repos,
      agentStatusByPaneKey: s.agentStatusByPaneKey
    }))
  )
  const entries = useMemo(
    () => pickCardStudioGallery(inputs, focusedWorktreeId),
    [inputs, focusedWorktreeId]
  )
  if (entries.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        {translate(
          'auto.components.cardStudio.galleryEmpty',
          'Add a workspace to see its card here.'
        )}
      </p>
    )
  }
  return (
    <div className="flex flex-wrap gap-4" inert>
      {entries.map((entry) => (
        <figure key={entry.key} className="flex flex-col gap-1.5" style={{ width: sidebarWidth }}>
          <figcaption className="text-2xs font-medium text-muted-foreground">
            {entry.label}
          </figcaption>
          <div className="rounded-lg border border-border bg-sidebar py-1 text-sidebar-foreground">
            <WorktreeCard worktree={entry.worktree} repo={entry.repo} isActive={false} />
          </div>
        </figure>
      ))}
    </div>
  )
}
