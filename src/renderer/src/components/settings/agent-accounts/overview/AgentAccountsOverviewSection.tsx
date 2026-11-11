// Wires S3 to the renderer's host list and the per-host sign-in probes. Rows open the A16 panel.
// No Orca Cloud row (JA-04): the page's own Orca Cloud part right below is the one place for it.
import React, { useMemo } from 'react'
import { useAppStore } from '@/store'
import { useTranslate } from '@/i18n/use-translate'
import { openAgentHostPanel } from '../../../agent-host-panel/agent-host-panel-store'
import {
  overviewRows,
  type OverviewAction,
  type OverviewHost,
  type OverviewRow
} from './agent-accounts-overview-model'
import { AgentAccountsOverview } from './AgentAccountsOverview'
import { overviewProbeTargets, useOverviewProbes } from './use-overview-probes'
import { useOverviewHosts } from './use-overview-hosts'

function openSettings(pane: 'accounts', sectionId?: string): void {
  const store = useAppStore.getState()
  store.openSettingsTarget({ pane, repoId: null, ...(sectionId ? { sectionId } : {}) })
  store.openSettingsPage()
}

export function AgentAccountsOverviewSection({
  hideHeader = false
}: {
  hideHeader?: boolean
}): React.JSX.Element {
  const t = useTranslate()
  const hosts = useOverviewHosts()
  const { probes, checkAgain, firstPassDone } = useOverviewProbes(hosts)
  const rows = useMemo(() => overviewRows({ hosts, probes, cloud: null }), [hosts, probes])
  const hostById = new Map<string, OverviewHost>(hosts.map((host) => [host.hostId, host]))
  const open = (row: OverviewRow, focus?: 'claude' | 'codex'): void => {
    const host = row.hostId ? hostById.get(row.hostId) : undefined
    if (!host) {
      return
    }
    openAgentHostPanel({
      hostId: host.hostId,
      host: { label: host.label, health: host.health },
      ...(focus ? { focus } : {})
    })
  }
  const onAction = (row: OverviewRow, action: OverviewAction): void => {
    switch (action.kind) {
      case 'review':
        open(row, action.agent)
        return
      case 'checkAgain': {
        const host = row.hostId ? hostById.get(row.hostId) : undefined
        if (host) {
          checkAgain(host)
        }
        return
      }
      case 'accounts':
        openSettings('accounts', 'accounts-this-host')
        return
      case 'manage':
        open(row)
    }
  }
  const checked = overviewProbeTargets(hosts).length
  const summary = firstPassDone
    ? t('agentAccountsOverview.summary', 'Checked {{count}} hosts. {{attention}} need attention.', {
        count: checked,
        attention: rows.filter((row) => row.attention).length
      })
    : ''
  return (
    <AgentAccountsOverview
      rows={rows}
      signedOutOfOrca={false}
      hideHeader={hideHeader}
      summary={summary}
      onOpenRow={(row) => open(row)}
      onAction={onAction}
    />
  )
}
