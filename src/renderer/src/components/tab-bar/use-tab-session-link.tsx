import { useState, useSyncExternalStore } from 'react'
import { useAppStore } from '@/store'
import {
  readLocalRuntimeCapabilityObservation,
  subscribeLocalRuntimeCapabilityObservation
} from '@/runtime/hosts/capabilities/local-runtime-capabilities'
import { getStructuredAgentSessionStatusFeed } from '@/runtime/structured-agent-session-status-feed'
import { SESSION_LINK_CAPABILITY } from '../../../../shared/session-link'
import { SessionLinkControl } from '../native-chat/SessionLinkControl'
import { tabSessionLinkRequest } from './tab-session-link'

export function useTabSessionLink(workspaceId: string, tabId: string, menuOpen: boolean) {
  const capability = useSyncExternalStore(
    subscribeLocalRuntimeCapabilityObservation,
    readLocalRuntimeCapabilityObservation
  )
  const eligible = useAppStore((state) =>
    menuOpen ? tabSessionLinkRequest(state, workspaceId, tabId) !== null : false
  )
  const [request, setRequest] = useState<ReturnType<typeof tabSessionLinkRequest>>(null)
  const available =
    eligible &&
    capability.state === 'known' &&
    capability.capabilities.includes(SESSION_LINK_CAPABILITY)
  return {
    onOpen: available
      ? () =>
          setRequest(
            tabSessionLinkRequest(
              useAppStore.getState(),
              workspaceId,
              tabId,
              getStructuredAgentSessionStatusFeed({ kind: 'local' }).getNamingSnapshot()
            )
          )
      : undefined,
    dialog: request ? (
      <SessionLinkControl
        key={`${request.sessionId}:${request.partnerSessionId ?? ''}`}
        sessionId={request.sessionId}
        target={{ kind: 'local' }}
        initialPartnerSessionId={request.partnerSessionId}
        sourceName={request.sourceName}
        partnerName={request.partnerName}
        dialogOnly
        onDismiss={() => setRequest(null)}
      />
    ) : null
  }
}
