import { formatOrcaSessionAddress, isOrcaSessionId } from '../../../../shared/orca-session-address'
import { OrchestrationCrewPanel } from './OrchestrationCrewPanel'
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

/** The chat body below the pane header; the crew panel overlays it, never the header's buttons. */
export function NativeChatCrewFrame({
  pane,
  children
}: {
  pane: { target: RuntimeClientTarget; sessionId: string; isVisible: boolean }
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <NativeChatCrewPanel
        target={pane.target}
        sessionId={pane.sessionId}
        isVisible={pane.isVisible}
      />
      {children}
    </div>
  )
}
