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
