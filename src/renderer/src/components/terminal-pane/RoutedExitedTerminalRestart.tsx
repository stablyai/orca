import { useEffect, useEffectEvent } from 'react'
import { useAppStore } from '@/store'

/**
 * Runs a restart main routed here (from a phone or a paired client) as this exited pane's own
 * Restart. Mounted only while the pane shows an exit, so live panes pay no subscription for it.
 */
export function RoutedExitedTerminalRestart({
  leafId,
  onRestart
}: {
  leafId: string
  onRestart: () => void
}): null {
  const requested = useAppStore((s) => s.pendingExitedTerminalRestartLeafIds[leafId] === true)
  const restart = useEffectEvent(onRestart)
  useEffect(() => {
    if (requested && useAppStore.getState().consumeExitedTerminalRestart(leafId)) {
      restart()
    }
  }, [leafId, requested])
  return null
}
