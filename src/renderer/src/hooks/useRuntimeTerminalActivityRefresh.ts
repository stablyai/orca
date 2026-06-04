import { useEffect } from 'react'
import { useAppStore } from '@/store'

const RUNTIME_TERMINAL_ACTIVITY_REFRESH_MS = 5_000

export function useRuntimeTerminalActivityRefresh(): void {
  const workspaceSessionReady = useAppStore((s) => s.workspaceSessionReady)
  const activeRuntimeEnvironmentId = useAppStore(
    (s) => s.settings?.activeRuntimeEnvironmentId ?? null
  )
  const refreshRuntimeTerminalActivity = useAppStore((s) => s.refreshRuntimeTerminalActivity)
  const clearRuntimeTerminalActivity = useAppStore((s) => s.clearRuntimeTerminalActivity)

  useEffect(() => {
    if (!workspaceSessionReady) {
      clearRuntimeTerminalActivity()
      return
    }

    const refresh = (): void => {
      void refreshRuntimeTerminalActivity()
    }

    // Why: renderer tab state can miss connected runtime PTYs after graph loss
    // or agent-row dismissal, so poll the runtime source of truth once per app.
    refresh()
    const timer = window.setInterval(refresh, RUNTIME_TERMINAL_ACTIVITY_REFRESH_MS)
    return () => window.clearInterval(timer)
  }, [
    activeRuntimeEnvironmentId,
    clearRuntimeTerminalActivity,
    refreshRuntimeTerminalActivity,
    workspaceSessionReady
  ])
}
