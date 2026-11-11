// Wires S3 to the renderer's host list, the per-host sign-in probes and the Orca account. Rows open
// the A16 panel; the Orca Cloud row scrolls to S0 below (one row stands for every cloud workspace).
import React, { useEffect, useMemo, useState } from 'react'
import { useAppStore } from '@/store'
import { useTranslate } from '@/i18n/use-translate'
import { useOrcaCloudAgentAccounts } from '@/lib/orca-cloud/orca-cloud-agent-accounts-store'
import { openAgentHostPanel } from '../../../agent-host-panel/agent-host-panel-store'
import { ORCA_CLOUD_ACCOUNTS_SECTION_ID } from '../OrcaCloudAccounts'
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

/** A member can't change team keys: their key cells say "set by your team". */
function useIsCloudMember(enabled: boolean): boolean {
  const [member, setMember] = useState(false)
  useEffect(() => {
    if (!enabled) {
      return
    }
    let cancelled = false
    void (window.api.cloudSecrets?.effective({}) ?? Promise.resolve(null))
      .catch(() => null)
      .then((result) => {
        if (!cancelled && result?.ok) {
          setMember(!result.value.caller.canWrite.org)
        }
      })
    return () => {
      cancelled = true
    }
  }, [enabled])
  return member
}

export function AgentAccountsOverviewSection({
  hideHeader = false
}: {
  hideHeader?: boolean
}): React.JSX.Element {
  const t = useTranslate()
  const hosts = useOverviewHosts()
  const { probes, checkAgain, firstPassDone } = useOverviewProbes(hosts)
  const accounts = useOrcaCloudAgentAccounts()
  const ready = accounts.load.kind === 'ready'
  const member = useIsCloudMember(ready)
  const signedOutOfOrca = accounts.load.kind === 'failed' && accounts.load.error === 'signed_out'
  const rows = useMemo(
    () =>
      overviewRows({
        hosts,
        probes,
        cloud:
          accounts.load.kind === 'ready'
            ? { status: accounts.load.status, keyKinds: accounts.keyKinds, member }
            : null
      }),
    [hosts, probes, accounts.load, accounts.keyKinds, member]
  )
  const hostById = new Map<string, OverviewHost>(hosts.map((host) => [host.hostId, host]))
  const open = (row: OverviewRow, focus?: 'claude' | 'codex'): void => {
    const host = row.hostId ? hostById.get(row.hostId) : undefined
    if (!host) {
      // Orca Cloud: S0 below owns setup and the Source for every cloud workspace.
      document.getElementById(ORCA_CLOUD_ACCOUNTS_SECTION_ID)?.scrollIntoView({ block: 'start' })
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
      signedOutOfOrca={signedOutOfOrca}
      hideHeader={hideHeader}
      summary={summary}
      onOpenRow={(row) => open(row)}
      onAction={onAction}
    />
  )
}
