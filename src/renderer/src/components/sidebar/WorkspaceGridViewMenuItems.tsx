import type { JSX } from 'react'
import { LayoutGrid } from 'lucide-react'
import { DropdownMenuItem } from '@/components/ui/dropdown-menu'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import { showWorkspaceView } from '@/lib/workspace-view-actions'
import { WORKSPACE_VIEW_MAX_SAVED } from '@/lib/workspace-view-layout'

export function WorkspaceGridViewMenuItems({
  workspaceId,
  disabled
}: {
  workspaceId: string
  disabled: boolean
}): JSX.Element {
  const savedLimitReached = useAppStore(
    (state) =>
      !state.activeWorkspaceViewId && state.workspaceViews.length >= WORKSPACE_VIEW_MAX_SAVED
  )
  return (
    <DropdownMenuItem
      disabled={disabled || savedLimitReached}
      onSelect={() => {
        const state = useAppStore.getState()
        if (state.activeWorkspaceViewId) {
          showWorkspaceView(state.activeWorkspaceViewId)
        } else {
          const id = state.createWorkspaceView(
            translate('workspaceViews.defaultName', 'Untitled view')
          )
          if (!id) {
            return
          }
        }
        state.setActiveView('terminal')
        state.setWorkspaceViewPicker({ workspaceId })
      }}
    >
      <LayoutGrid />
      {translate('workspaceViews.addWorkspacePanels', 'Add panels to view…')}
    </DropdownMenuItem>
  )
}
