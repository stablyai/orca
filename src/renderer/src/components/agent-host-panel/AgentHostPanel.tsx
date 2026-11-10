// The app's one "Agent accounts & secrets" sheet. Opened through openAgentHostPanel({ hostId, focus });
// it resolves the host from renderer state and never connects, wakes, starts or resumes it.
import React, { useState, useSyncExternalStore } from 'react'
import {
  readHostAgentSignInReport,
  subscribeHostAgentSignInReports
} from '@/runtime/provider-accounts/sign-in/host-agent-sign-in-status-client'
import { formatDate } from '../settings/agent-accounts/orca-cloud-account-row-shell'
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
import { useHostPanelBody } from './HostPanelBody'
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
      focusAgent={focus === 'claude' || focus === 'codex' ? focus : undefined}
    />
  )
}

const NO_ENVIRONMENT = '\u0000'

/** Every other kind: the host's own sign-ins, this computer's keys that apply, one env line. */
export function HostPanel({
  host,
  focus
}: {
  host: ResolvedAgentHost
  focus?: AgentHostPanelFocus
}): React.JSX.Element {
  const t = useTranslate()
  const [generation, setGeneration] = useState(0)
  const cached = useSyncExternalStore(subscribeHostAgentSignInReports, () =>
    readHostAgentSignInReport(host.environmentId ?? NO_ENVIRONMENT)
  )
  const capabilities = hostCapabilities(
    host.kind,
    host.availability,
    { host: host.label, date: cached ? formatDate(cached.checkedAt) : null },
    t
  )
  const body = useHostPanelBody(host, capabilities, generation, () =>
    setGeneration((value) => value + 1)
  )
  return (
    <AgentHostPanelView
      capabilities={capabilities}
      subject={host.label}
      dot={
        host.kind === 'recipe'
          ? host.availability === 'available'
            ? 'running'
            : host.availability === 'suspended'
              ? 'sleeping'
              : 'unknown'
          : null
      }
      agents={body.agents}
      keys={body.keys}
      environment={body.environment}
      onFooterLink={openAgentHostSettings}
      focusAgent={focus === 'claude' || focus === 'codex' ? focus : undefined}
    />
  )
}

export function AgentHostPanel(): React.JSX.Element {
  const request = useAgentHostPanelRequest()
  const host = useResolvedAgentHost(request)
  return (
    <Sheet open={host !== null} onOpenChange={(open) => !open && closeAgentHostPanel()}>
      {host?.kind === 'cloud' ? (
        <CloudHostPanel key={host.hostId} host={host} focus={request?.focus} />
      ) : host ? (
        <HostPanel key={host.hostId} host={host} focus={request?.focus} />
      ) : null}
    </Sheet>
  )
}
