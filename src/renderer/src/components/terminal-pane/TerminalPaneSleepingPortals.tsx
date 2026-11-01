import { createPortal } from 'react-dom'
import { makePaneKey } from '../../../../shared/stable-pane-id'
import type { ManagedPane } from '@/lib/pane-manager/pane-manager'
import { usePaneSpawnDeferral } from '@/lib/pane-spawn-deferral-registry'
import { TerminalSleepingPaneOverlay } from './TerminalSleepingPaneOverlay'
import type { TerminalPaneController } from './use-terminal-pane-controller'

function SleepingPanePortal({
  pane,
  tabId
}: {
  pane: ManagedPane
  tabId: string
}): React.JSX.Element | null {
  const deferral = usePaneSpawnDeferral(makePaneKey(tabId, pane.leafId))
  if (!deferral || deferral.resuming) {
    return null
  }
  return createPortal(
    <TerminalSleepingPaneOverlay
      reason={deferral.reason}
      onResume={deferral.resume}
      onResumeAutomaticRestores={deferral.resumeAutomaticRestores}
    />,
    pane.container,
    `sleeping-pane-${pane.id}`
  )
}

export function TerminalPaneSleepingPortals({
  controller
}: {
  controller: TerminalPaneController
}): React.JSX.Element {
  const { managedPanes, tabId } = controller
  return (
    <>
      {managedPanes.map((pane) => (
        <SleepingPanePortal key={pane.id} pane={pane} tabId={tabId} />
      ))}
    </>
  )
}
