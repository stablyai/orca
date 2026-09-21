import { useEffect, useState } from 'react'

const WORKSPACE_BOARD_CLOSE_LINGER_MS = 300

export function useWorkspaceKanbanDrawerLingering(open: boolean): boolean {
  const [lingering, setLingering] = useState(open)
  useEffect(() => {
    if (open) {
      setLingering(true)
      return
    }
    const timer = window.setTimeout(() => setLingering(false), WORKSPACE_BOARD_CLOSE_LINGER_MS)
    return () => window.clearTimeout(timer)
  }, [open])
  return lingering
}
