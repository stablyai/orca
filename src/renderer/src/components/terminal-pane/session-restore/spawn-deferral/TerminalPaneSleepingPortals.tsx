import { Suspense } from 'react'
import { createPortal } from 'react-dom'
import { lazyWithRetry as lazy } from '@/app-shell/startup/lazy-with-retry'
import { makePaneKey } from '../../../../../../shared/workspace-layout/stable-pane-id'
import type { ManagedPane } from '@/lib/pane-manager/pane-manager-types'
import { usePaneSpawnDeferral } from '@/components/terminal-pane/session-restore/spawn-deferral/pane-spawn-deferral-registry'
import type { TerminalPaneController } from '../../controller/use-terminal-pane-controller'

const TerminalSleepingPaneOverlay = lazy(() =>
  import('./TerminalSleepingPaneOverlay').then((module) => ({
    default: module.TerminalSleepingPaneOverlay
  }))
)

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
    <Suspense fallback={null}>
      <TerminalSleepingPaneOverlay
        reason={deferral.reason}
        onResume={deferral.resume}
        onResumeAutomaticRestores={deferral.resumeAutomaticRestores}
      />
    </Suspense>,
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
