import { useEffect, useState } from 'react'
import { DashboardBotAsksFeed } from '../bot-asks/DashboardBotAsks'
import { useDashboardPopoutBridge } from './useDashboardPopoutBridge'

/** Whether the pop-out window is open, so bot items are read only while it can show them. */
function useDashboardPopoutOpen(): boolean {
  const [open, setOpen] = useState(false)
  useEffect(() => {
    let disposed = false
    const off = window.api.dashboard.onPopoutOpenChanged((next) => setOpen(next))
    void window.api.dashboard.getPopoutOpen().then((isOpen) => {
      if (!disposed) {
        setOpen(isOpen)
      }
    })
    return () => {
      disposed = true
      off?.()
    }
  }, [])
  return open
}

export default function DashboardPopoutBridge(): React.JSX.Element | null {
  useDashboardPopoutBridge(true)
  return useDashboardPopoutOpen() ? <DashboardBotAsksFeed /> : null
}
