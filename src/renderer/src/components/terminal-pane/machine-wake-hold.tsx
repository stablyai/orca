import { useEffect } from 'react'
import { wakeMachineForHost } from '@/lib/machines/machine-wake-on-open'
import type { WorktreeMachineWake } from '@/store/slices/machines'
import type { PtyTransport } from './pty-transport-types'
import { TerminalRemoteRuntimeReconnectBanner } from './TerminalRemoteRuntimeReconnectBanner'
import { useTerminalSurfaceBackground } from './use-terminal-surface-background'

const SESSION_LIVE_POLL_MS = 200
// Why a cap: a pane that never connects shows its own recovery UI instead of a cover that stays.
export const SESSION_LIVE_TIMEOUT_MS = 20_000
const SWALLOWED_INPUT_EVENTS = ['keydown', 'keypress', 'beforeinput', 'paste'] as const

/** Stands in for a pane until its machine's wake settles; on failure it offers Retry. */
export function MachineWakeHold({
  wake,
  worktreeId
}: {
  wake: Pick<WorktreeMachineWake, 'machineName' | 'hostId' | 'failure'>
  worktreeId: string
}): React.JSX.Element {
  // Why: the held pane sits where the terminal will paint, so it shares its background (no flash);
  // the banner is its own card, so a terminal darker than the app is still readable.
  const background = useTerminalSurfaceBackground({ matchAppMode: false })
  return (
    <div
      className="absolute inset-0 z-40"
      data-terminal-machine-wake-hold={wake.failure ? 'failed' : 'waking'}
      style={background ? { backgroundColor: background } : undefined}
    >
      <TerminalRemoteRuntimeReconnectBanner
        phase={wake.failure ? 'disconnected' : 'recovering'}
        wakingMachineName={wake.machineName}
        wakeFailure={wake.failure}
        onReconnect={() => void wakeMachineForHost(wake.hostId, worktreeId)}
      />
    </div>
  )
}

/**
 * After the wake, the pane mounts under the hold until every transport is connected. A woken
 * machine's shell is usually a replacement, and the transport rightly drops keys typed at the
 * restored screen of the old one, so typing is swallowed here, visibly, until the session is live.
 */
export function useMachineWakeSettle(options: {
  settling: boolean
  containerRef: React.RefObject<HTMLDivElement | null>
  paneTransportsRef: React.RefObject<Map<number, PtyTransport>>
  onLive: () => void
}): void {
  const { settling, containerRef, paneTransportsRef, onLive } = options
  useEffect(() => {
    if (!settling) {
      return
    }
    const swallow = (event: Event): void => {
      if (event.target instanceof Node && containerRef.current?.contains(event.target)) {
        event.preventDefault()
        event.stopImmediatePropagation()
      }
    }
    for (const type of SWALLOWED_INPUT_EVENTS) {
      window.addEventListener(type, swallow, true)
    }
    const startedAt = Date.now()
    const timer = window.setInterval(() => {
      const transports = [...paneTransportsRef.current.values()]
      const live = transports.length > 0 && transports.every((transport) => transport.isConnected())
      if (live || Date.now() - startedAt >= SESSION_LIVE_TIMEOUT_MS) {
        onLive()
      }
    }, SESSION_LIVE_POLL_MS)
    return () => {
      window.clearInterval(timer)
      for (const type of SWALLOWED_INPUT_EVENTS) {
        window.removeEventListener(type, swallow, true)
      }
    }
  }, [settling, containerRef, paneTransportsRef, onLive])
}
