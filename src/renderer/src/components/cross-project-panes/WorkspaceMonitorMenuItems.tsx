import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import {
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger
} from '../ui/dropdown-menu'

export function WorkspaceMonitorMenuItems() {
  const [monitors, setMonitors] = useState<{ id: number; label: string }[]>([])
  const bridge = window.orcaWorkspaceViews
  useEffect(() => {
    let disposed = false
    void bridge
      ?.monitors?.()
      .then((entries) => {
        if (!disposed) {
          setMonitors(entries)
        }
      })
      .catch((error) => toast.error(String(error)))
    return () => {
      disposed = true
    }
  }, [bridge])
  if (!bridge?.monitors) {
    return null
  }
  const arrange = (run: () => Promise<number>) => {
    void run()
      .then((count) => {
        if (count > 0) {
          toast.success(`${count} windows arranged`)
        }
      })
      .catch((error) => toast.error(String(error)))
  }
  return (
    <>
      <DropdownMenuSub>
        <DropdownMenuSubTrigger>Move to Monitor</DropdownMenuSubTrigger>
        <DropdownMenuSubContent>
          {monitors.map((monitor) => (
            <DropdownMenuItem
              key={monitor.id}
              onSelect={() => {
                void bridge.moveToMonitor(monitor.id).catch((error) => toast.error(String(error)))
              }}
            >
              {monitor.label}
            </DropdownMenuItem>
          ))}
        </DropdownMenuSubContent>
      </DropdownMenuSub>
      <DropdownMenuItem
        onSelect={() => {
          void bridge.bringWindowsToMonitor().catch((error) => toast.error(String(error)))
        }}
      >
        Bring All Windows to This Monitor
      </DropdownMenuItem>
      <DropdownMenuSeparator />
      <DropdownMenuSub>
        <DropdownMenuSubTrigger>Arrange Windows</DropdownMenuSubTrigger>
        <DropdownMenuSubContent>
          <DropdownMenuItem
            onSelect={() => {
              arrange(bridge.tileWindowsOnMonitor)
            }}
          >
            Tile All Windows on This Monitor
          </DropdownMenuItem>
          <DropdownMenuItem
            onSelect={() => {
              arrange(bridge.distributeWindowsAcrossMonitors)
            }}
          >
            Distribute Windows Across Monitors
          </DropdownMenuItem>
        </DropdownMenuSubContent>
      </DropdownMenuSub>
    </>
  )
}
