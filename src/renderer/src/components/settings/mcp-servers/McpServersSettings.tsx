// Settings › MCP servers on the picked host: its list, or one server's page. A host that doesn't serve
// MCP servers (an older Orca, or one with them off) says so instead.
import React, { useCallback } from 'react'
import { useTranslate } from '@/i18n/use-translate'
import { useStructuredAgentSessionHostCapabilityState } from '@/runtime/native-chat/host-capabilities/structured-agent-session-host-capability'
import { MCP_SERVERS_RUNTIME_CAPABILITY } from '../../../../../shared/mcp-servers/mcp-servers'
import type { RuntimeClientTarget } from '../../../../../shared/remote-runtime/host-catalog/runtime-client-target'
import { useSettingsHostLabel } from '../host-scope/use-host-setting'
import type { McpServerSubPage } from './mcp-server-sub-page'
import { McpServersPane } from './McpServersPane'
import { McpServerPage } from './McpServerPage'

export function McpServersSettings({
  target,
  subPage,
  onSubPage
}: {
  target: RuntimeClientTarget
  subPage: McpServerSubPage | null
  onSubPage: (page: McpServerSubPage | null) => void
}): React.JSX.Element {
  const t = useTranslate()
  const hostName = useSettingsHostLabel(target)
  const support = useStructuredAgentSessionHostCapabilityState(
    target,
    MCP_SERVERS_RUNTIME_CAPABILITY
  )
  const subPageId = subPage?.id ?? null
  const host = target.kind === 'environment' ? target.environmentId : null
  const onTitle = useCallback(
    (title: string) => {
      if (subPageId) {
        onSubPage({ id: subPageId, title, host })
      }
    },
    [onSubPage, subPageId, host]
  )
  const back = useCallback(() => onSubPage(null), [onSubPage])

  if (support !== 'supported') {
    return (
      <p className="px-1 text-sm text-muted-foreground" role="status">
        {support === 'unknown'
          ? t('settings.mcpServers.loading', 'Reading MCP servers…')
          : t('settings.mcpServers.unsupported', 'MCP servers aren’t available on {{host}}.', {
              host: hostName
            })}
      </p>
    )
  }
  return subPage ? (
    <McpServerPage
      target={target}
      hostName={hostName}
      serverId={subPage.id}
      onTitle={onTitle}
      onBack={back}
    />
  ) : (
    <McpServersPane
      target={target}
      hostName={hostName}
      onOpenServer={(id, title) => onSubPage({ id, title, host })}
    />
  )
}
