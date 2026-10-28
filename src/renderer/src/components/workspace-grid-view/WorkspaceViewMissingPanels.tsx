import { useMemo } from 'react'
import { useAppStore } from '@/store'
import { selectShownWorkspaceView, resolveWorkspaceViewTab } from '@/lib/workspace-view-catalog'
import { measureWorkspaceViewLayout } from '@/lib/workspace-view-layout'
import { translate } from '@/i18n/i18n'
import { Button } from '../ui/button'
import { WorkspaceViewPanelSlot } from './WorkspaceViewPanelSlot'

export function WorkspaceViewMissingPanels({
  renderedWorkspaceIds
}: {
  renderedWorkspaceIds: ReadonlySet<string>
}): React.JSX.Element {
  const view = useAppStore(selectShownWorkspaceView)
  const expanded = useAppStore((state) => state.workspaceViewExpandedPanelId)
  const missingKey = useAppStore((state) =>
    JSON.stringify(
      view?.panels
        .filter((panel) => !resolveWorkspaceViewTab(state, panel))
        .map((panel) => panel.id) ?? []
    )
  )
  const missing = useMemo(() => new Set<string>(JSON.parse(missingKey)), [missingKey])
  const rects = useMemo(
    () => measureWorkspaceViewLayout(view?.layout ?? null).panels,
    [view?.layout]
  )
  return (
    <>
      {view?.panels.map((panel) => {
        if (expanded && expanded !== panel.id) {
          return null
        }
        if (renderedWorkspaceIds.has(panel.workspaceId) && !missing.has(panel.id)) {
          return null
        }
        const rect = expanded ? { left: 0, top: 0, width: 100, height: 100 } : rects.get(panel.id)
        return rect ? (
          <WorkspaceViewPanelSlot
            key={panel.id}
            panel={panel}
            tab={null}
            rect={rect}
            focused={false}
            expanded={expanded === panel.id}
          />
        ) : null
      })}
      {view?.panels.length === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-sm text-muted-foreground">
          <p>
            {translate(
              'workspaceViews.empty',
              'Keep the panels you work with together in this view.'
            )}
          </p>
          <Button onClick={() => useAppStore.getState().setWorkspaceViewPicker({})}>
            {translate('workspaceViews.addPanel', 'Add panel')}
          </Button>
        </div>
      ) : null}
    </>
  )
}
