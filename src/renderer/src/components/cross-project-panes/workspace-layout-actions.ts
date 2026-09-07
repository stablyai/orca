import { useAppStore } from '@/store'
import { toast } from 'sonner'

export async function recoverWorkspaceLayout(closed: boolean): Promise<void> {
  const state = useAppStore.getState()
  const transferId = !closed && state.workspaceLayoutHistory.at(-1)?.transferId
  if (transferId) {
    if (!(await window.orcaWorkspaceViews?.undoTransfer(transferId))) {
      toast.error('The layout change is unavailable while its window is disconnected.')
    }
    return
  }
  if ((closed ? state.closedWorkspaceViews : state.workspaceLayoutHistory).length) {
    if (closed) {
      state.reopenClosedWorkspaceView()
    } else {
      state.undoWorkspaceLayoutChange()
    }
  } else if (window.orcaWorkspaceViews?.reopenWindow) {
    try {
      await window.orcaWorkspaceViews.reopenWindow()
    } catch (error) {
      toast.error(String(error))
    }
  }
}

export function paneLayoutActions(paneId: string) {
  const state = useAppStore.getState()
  return [
    {
      label: 'Undo Layout Change',
      run: () => recoverWorkspaceLayout(false),
      disabled: !state.workspaceLayoutHistory.length && !window.orcaWorkspaceViews
    },
    {
      label: 'Reopen Closed View',
      run: () => recoverWorkspaceLayout(true),
      disabled: !state.closedWorkspaceViews.length && !window.orcaWorkspaceViews
    },
    { label: 'Split Right', run: () => state.splitWindowPane(paneId, 'horizontal') },
    { label: 'Split Down', run: () => state.splitWindowPane(paneId, 'vertical') },
    {
      label: state.windowPaneLayout?.expandedPaneId ? 'Restore Layout' : 'Expand Pane',
      run: () => state.expandWindowPane(paneId)
    },
    {
      label: 'Close Pane',
      run: () => state.closeWindowPane(paneId),
      disabled: state.windowPaneLayout?.root.type !== 'split'
    }
  ]
}

export async function transferPaneViews(
  paneId: string,
  destinationId: number | 'new',
  action: string
) {
  const bridge = window.orcaWorkspaceViews
  if (!bridge) {
    return
  }
  const pane = useAppStore.getState().windowPaneLayout?.panes[paneId]
  const viewIds = action.startsWith('Move')
    ? pane?.selectedViewId
      ? [pane.selectedViewId]
      : []
    : undefined
  if (viewIds?.length === 0) {
    return
  }
  const destination = destinationId === 'new' ? await bridge.createWindow() : destinationId
  const ok = await bridge.transfer({
    destinationId: destination,
    mode: action.endsWith('Panes') ? 'panes' : 'tabs',
    ...(viewIds ? { viewIds } : {})
  })
  if (!ok) {
    toast.error('The transfer could not be confirmed. Your sessions are still running.')
  }
}
