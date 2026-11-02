import { formatOrcaSessionAddress, isOrcaSessionId } from '../../../../shared/orca-session-address'
import { OrchestrationCrewPanel } from './OrchestrationCrewPanel'
import { useOrchestrationPanelEnabled } from './use-orchestration-panel-enabled'
import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'

export function NativeChatCrewPanel({
  target,
  party: suppliedParty,
  sessionId,
  isVisible = true
}: {
  target: RuntimeClientTarget | null
  party?: string | null
  sessionId?: string
  isVisible?: boolean
}): React.JSX.Element | null {
  const party =
    suppliedParty ??
    (sessionId && isOrcaSessionId(sessionId) ? formatOrcaSessionAddress(sessionId) : null)
  if (!target || !party) {
    return null
  }
  return <OrchestrationCrewPanel target={target} party={party} isVisible={isVisible} />
}

/** Wraps a native chat's transcript: the crew panel overlays it, never the header's buttons or the composer below it. */
export function NativeChatCrewFrame({
  panel,
  children
}: {
  /** Mounted only while the experimental setting is on, so an off panel costs no queries. */
  panel: React.ReactNode
  children: React.ReactNode
}): React.JSX.Element {
  const enabled = useOrchestrationPanelEnabled()
  // The wrapper stays either way so toggling the setting never remounts the transcript.
  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      {enabled ? (
        // Clips the panel to the transcript even when it is shorter than the panel's header.
        <div className="pointer-events-none absolute inset-0 overflow-hidden">{panel}</div>
      ) : null}
      {children}
    </div>
  )
}
