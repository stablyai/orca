import { useMemo, useState } from 'react'
import { useAppStore } from '@/store'
import { useStructuredAgentSessionHostCapabilityState } from '@/runtime/native-chat/host-capabilities/structured-agent-session-host-capability'
import {
  structuredAgentSessionOwnerForTab,
  structuredAgentSessionTargetForHost
} from '@/runtime/native-chat/session-ownership/structured-agent-session-owner'
import { getStructuredAgentSessionStatusFeed } from '@/runtime/native-chat/status/structured-agent-session-status-feed'
import {
  SESSION_LINK_CAPABILITY,
  SESSION_LINK_PAIRED_DESKTOP_CAPABILITY
} from '../../../../shared/session-link'
import { SessionLinkControl } from '../native-chat/SessionLinkControl'
import { tabSessionLinkRequest } from './tab-session-link'

export function useTabSessionLink(workspaceId: string, tabId: string, menuOpen: boolean) {
  const owner = useAppStore((state) => {
    const tab = menuOpen
      ? state.unifiedTabsByWorktree[workspaceId]?.find((entry) => entry.id === tabId)
      : undefined
    return tab ? structuredAgentSessionOwnerForTab(state, tab) : null
  })
  const target = useMemo(() => structuredAgentSessionTargetForHost(owner), [owner])
  const capability = useStructuredAgentSessionHostCapabilityState(
    target,
    target?.kind === 'environment'
      ? SESSION_LINK_PAIRED_DESKTOP_CAPABILITY
      : SESSION_LINK_CAPABILITY
  )
  const eligible = useAppStore((state) =>
    menuOpen ? tabSessionLinkRequest(state, workspaceId, tabId) !== null : false
  )
  const [request, setRequest] = useState<ReturnType<typeof tabSessionLinkRequest>>(null)
  const available = eligible && capability === 'supported'
  return {
    onOpen: available
      ? () =>
          setRequest(
            tabSessionLinkRequest(
              useAppStore.getState(),
              workspaceId,
              tabId,
              target ? getStructuredAgentSessionStatusFeed(target).getNamingSnapshot() : undefined
            )
          )
      : undefined,
    dialog: request ? (
      <SessionLinkControl
        key={`${JSON.stringify(request.target)}:${request.sessionId}:${request.partnerSessionId ?? ''}`}
        sessionId={request.sessionId}
        target={request.target}
        initialPartnerSessionId={request.partnerSessionId}
        sourceName={request.sourceName}
        partnerName={request.partnerName}
        dialogOnly
        onDismiss={() => setRequest(null)}
      />
    ) : null
  }
}
