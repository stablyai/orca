import { formatOrcaSessionAddress, isOrcaSessionId } from '../../../../shared/orca-session-address'
import type { RefObject } from 'react'
import type { NativeChatComposerHandle } from '../native-chat/native-chat-composer-types'
import { OrchestrationCrewPanel } from './OrchestrationCrewPanel'
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
    <OrchestrationCrewPanel
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
  crew,
  children
}: {
  crew: React.ComponentProps<typeof NativeChatCrewPanel>
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <NativeChatCrewPanel {...crew} />
      {children}
    </div>
  )
}
