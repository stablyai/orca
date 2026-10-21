import { useCallback, useState } from 'react'
import { useAppStore } from '@/store'
import { TerminalPaneSurface } from './TerminalPaneSurface'
import { useTerminalPaneController } from './use-terminal-pane-controller'
import { MachineWakeHold, useMachineWakeSettle } from './machine-wake-hold'
import type { TerminalPaneProps } from './terminal-pane-types'

function TerminalPaneAttached({
  settlingMachineName,
  hostId,
  onLive,
  ...props
}: TerminalPaneProps & {
  settlingMachineName: string | null
  hostId: string
  onLive: () => void
}): React.JSX.Element {
  const controller = useTerminalPaneController(props)
  useMachineWakeSettle({
    settling: settlingMachineName !== null,
    containerRef: controller.containerRef,
    paneTransportsRef: controller.paneTransportsRef,
    onLive
  })
  return (
    <>
      <TerminalPaneSurface controller={controller} />
      {settlingMachineName !== null ? (
        <MachineWakeHold
          wake={{ machineName: settlingMachineName, hostId, failure: null }}
          worktreeId={props.worktreeId}
        />
      ) : null}
    </>
  )
}

/**
 * Opened onto a machine that is waking, a pane holds its first attach until wake and connect
 * settle, then attaches once under the same banner until its session is live: attaching to a cold
 * host fails, and keys typed before the reattach lands are lost. A pane that already attached
 * keeps its own recovery.
 */
export default function TerminalPane(props: TerminalPaneProps): React.JSX.Element {
  const wake = useAppStore((state) => state.machineWakeByWorktreeId[props.worktreeId] ?? null)
  const [hold, setHold] = useState<{
    phase: 'held' | 'settling'
    machineName: string
    hostId: string
  } | null>(() =>
    wake ? { phase: 'held', machineName: wake.machineName, hostId: wake.hostId } : null
  )
  if (hold?.phase === 'held' && wake === null) {
    setHold({ ...hold, phase: 'settling' })
  }
  const onLive = useCallback(() => setHold(null), [])
  if (hold?.phase === 'held' && wake) {
    return <MachineWakeHold wake={wake} worktreeId={props.worktreeId} />
  }
  return (
    <TerminalPaneAttached
      {...props}
      settlingMachineName={hold?.phase === 'settling' ? hold.machineName : null}
      hostId={hold?.hostId ?? ''}
      onLive={onLive}
    />
  )
}
