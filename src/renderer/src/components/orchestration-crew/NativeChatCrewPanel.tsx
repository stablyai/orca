import { formatOrcaSessionAddress, isOrcaSessionId } from '../../../../shared/orca-session-address'
import type { RefObject } from 'react'
import type { NativeChatComposerHandle } from '../native-chat/composer/native-chat-composer-types'
import { LazyOrchestrationCrewPanel } from './LazyOrchestrationCrewPanel'
import { useOrchestrationPanelEnabled } from './use-orchestration-panel-enabled'
import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'

export function NativeChatCrewPanel({
  target,
  party: suppliedParty,
  sessionId,
  composerRef,
  canMention,
  isVisible = true
}: {
  target: RuntimeClientTarget | null
  party?: string | null
  sessionId?: string
  composerRef: RefObject<NativeChatComposerHandle | null>
  canMention: boolean
  isVisible?: boolean
}): React.JSX.Element | null {
  const party =
    suppliedParty ??
    (sessionId && isOrcaSessionId(sessionId) ? formatOrcaSessionAddress(sessionId) : null)
  if (!target || !party) {
    return null
  }
  const hostKey = target.kind === 'local' ? 'local' : target.environmentId
  return (
    <LazyOrchestrationCrewPanel
      target={target}
      party={party}
      isVisible={isVisible}
      canMention={canMention}
      mention={(rows) => {
        composerRef.current?.insertAgentReferences(
          rows.flatMap((row) =>
            row.sendAddress ? [{ label: row.label, address: row.sendAddress, hostKey }] : []
          )
        )
      }}
    />
  )
}

/** Wraps a native chat's transcript: the crew panel overlays it, never the header's buttons or the composer below it. */
export function NativeChatCrewFrame({
  panel,
  children
}: {
  /** The availability gate prevents unavailable panels from acquiring subscriptions. */
  panel: React.ReactNode
  children: React.ReactNode
}): React.JSX.Element {
  const enabled = useOrchestrationPanelEnabled()
  // Keep transcript layout independent of panel availability.
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
