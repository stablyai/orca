// The app's one "Agent accounts & secrets" sheet. Opened through openAgentHostPanel({ hostId, focus });
// it resolves the host from renderer state and never connects, wakes, starts or resumes it.
import React from 'react'
import { Sheet } from '@/components/ui/sheet'
import { useTranslate } from '@/i18n/use-translate'
import { hostCapabilities } from './agent-host-capabilities'
import {
  closeAgentHostPanel,
  useAgentHostPanelRequest,
  type AgentHostPanelFocus
} from './agent-host-panel-store'
import { AgentHostPanelView } from './AgentHostPanelView'
import { useCloudHostPanelBody } from './CloudHostPanelBody'
import { openAgentHostSettings } from './open-agent-host-settings'
import { useResolvedAgentHost, type ResolvedAgentHost } from './use-agent-host'

export function CloudHostPanel({
  host,
  focus
}: {
  host: ResolvedAgentHost
  focus: AgentHostPanelFocus | undefined
}): React.JSX.Element {
  const t = useTranslate()
  const capabilities = hostCapabilities(
    host.kind,
    host.availability,
    { host: host.label, date: null },
    t
  )
  const body = useCloudHostPanelBody(host, capabilities, focus)
  return (
    <AgentHostPanelView
      capabilities={capabilities}
      subject={host.cloud?.workspaceLabel ?? null}
      dot={host.cloud?.dot ?? null}
      agents={body.agents}
      cloudSections={body.cloudSections}
      onFooterLink={openAgentHostSettings}
    />
  )
}

export function AgentHostPanel(): React.JSX.Element {
  const request = useAgentHostPanelRequest()
  const host = useResolvedAgentHost(request)
  // v1: Orca Cloud hosts; the other kinds follow with their own section 1.
  const cloud = host?.kind === 'cloud' ? host : null
  return (
    <Sheet open={cloud !== null} onOpenChange={(open) => !open && closeAgentHostPanel()}>
      {cloud ? <CloudHostPanel key={cloud.hostId} host={cloud} focus={request?.focus} /> : null}
    </Sheet>
  )
}
