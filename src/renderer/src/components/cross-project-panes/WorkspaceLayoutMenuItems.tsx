import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { useAppStore } from '@/store'
import {
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger
} from '../ui/dropdown-menu'
import { paneLayoutActions, transferPaneViews } from './workspace-layout-actions'
import { projectPaneContext } from './project-pane-context'
import { WorkspaceMonitorMenuItems } from './WorkspaceMonitorMenuItems'

export function WorkspaceLayoutMenuItems({ paneId, viewId }: { paneId: string; viewId?: string }) {
  const [windows, setWindows] = useState<{ id: number; title: string }[]>([])
  const [busy, setBusy] = useState(false)
  const bridge = window.orcaWorkspaceViews
  const layout = useAppStore((state) => state.windowPaneLayout)
  const selected = viewId ?? layout?.panes[paneId]?.selectedViewId
  useEffect(() => {
    if (!bridge) {
      return
    }
    let disposed = false
    void Promise.all([bridge.ready(), bridge.list()])
      .then(([id, entries]) => {
        if (!disposed) {
          setWindows(entries.filter((entry) => entry.id !== id))
        }
      })
      .catch((error) => toast.error(String(error)))
    return () => {
      disposed = true
    }
  }, [bridge])
  const focus = () => useAppStore.getState().focusWindowPane(paneId, selected ?? undefined)
  const transfer = async (destinationId: number | 'new', action: string) => {
    focus()
    setBusy(true)
    try {
      await transferPaneViews(paneId, destinationId, action)
    } catch (error) {
      toast.error(String(error))
    } finally {
      setBusy(false)
    }
  }
  return (
    <>
      {paneLayoutActions(paneId).map((action) => (
        <DropdownMenuItem
          key={action.label}
          disabled={busy || action.disabled}
          onSelect={() => {
            focus()
            action.run()
          }}
        >
          {action.label}
        </DropdownMenuItem>
      ))}
      <DropdownMenuSub>
        <DropdownMenuSubTrigger disabled={!selected || busy}>Move to Pane</DropdownMenuSubTrigger>
        <DropdownMenuSubContent>
          {Object.values(layout?.panes ?? {})
            .filter((pane) => pane.id !== paneId)
            .map((pane, index) => {
              const context = projectPaneContext(
                useAppStore.getState(),
                layout!.views[pane.selectedViewId ?? ''] ?? pane.workspace
              )
              return (
                <DropdownMenuItem
                  key={pane.id}
                  onSelect={() => {
                    if (selected) {
                      useAppStore
                        .getState()
                        .moveWorkspaceView(selected, { paneId: pane.id, zone: 'center' })
                    }
                  }}
                >
                  {context.projectName} / {context.workspace} · {context.hostName} ({index + 1})
                </DropdownMenuItem>
              )
            })}
          {Object.keys(layout?.panes ?? {}).length < 2 && (
            <DropdownMenuItem disabled>No other panes</DropdownMenuItem>
          )}
        </DropdownMenuSubContent>
      </DropdownMenuSub>
      {bridge && (
        <>
          <DropdownMenuSeparator />
          <WorkspaceMonitorMenuItems />
          <DropdownMenuItem
            disabled={busy}
            onSelect={() => {
              void bridge.createWindow().catch((error) => toast.error(String(error)))
            }}
          >
            New Window
          </DropdownMenuItem>
          <DropdownMenuItem
            disabled={!selected || busy}
            onSelect={() => {
              void transfer('new', 'Move to Window')
            }}
          >
            Move to New Window
          </DropdownMenuItem>
          {['Move to Window', 'Combine Windows as Tabs', 'Combine Windows as Panes'].map(
            (label) => (
              <DropdownMenuSub key={label}>
                <DropdownMenuSubTrigger disabled={busy}>{label}</DropdownMenuSubTrigger>
                <DropdownMenuSubContent>
                  {windows.length ? (
                    windows.map((entry) => (
                      <DropdownMenuItem
                        key={entry.id}
                        onSelect={() => {
                          void transfer(entry.id, label)
                        }}
                      >
                        {entry.title} ({entry.id})
                      </DropdownMenuItem>
                    ))
                  ) : (
                    <DropdownMenuItem disabled>No other windows</DropdownMenuItem>
                  )}
                </DropdownMenuSubContent>
              </DropdownMenuSub>
            )
          )}
        </>
      )}
    </>
  )
}
