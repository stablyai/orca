// The panel on an Orca Cloud host: section 1 from the Orca account, sections 2–3 from Cloud secrets
// (W6's CloudPanelSections) with the A6 offer for keys only on this computer. Every read goes to the
// control plane; the sandbox is never asked, so an asleep one stays asleep.
import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'
import { useAppStore } from '@/store'
import { useTranslate } from '@/i18n/use-translate'
import {
  reloadOrcaCloudAgentAccounts,
  useOrcaCloudAgentAccounts
} from '@/lib/orca-cloud/orca-cloud-agent-accounts-store'
import type {
  AgentSource,
  AgentSourcesView,
  OrcaCloudAccountAgent
} from '../../../../shared/orca-cloud-agents/orca-cloud-agents-wire'
import { useCloudAgentSetup } from '../cloud-agent-setup/use-cloud-agent-setup'
import { CloudDesktopKeysOffer } from '../cloud-agent-setup/CloudDesktopKeysOffer'
import {
  CloudAgentKeysSection,
  CloudEnvironmentPanelSection
} from './cloud-sections/CloudPanelSections'
import { useCloudPanelSections } from './cloud-sections/use-cloud-panel-sections'
import { CloudAgentsPanelSection, type CloudAgentsPanelLoad } from './CloudAgentsPanelSection'
import { cloudAgentPanelRows } from './cloud-agents-panel-model'
import type { AgentHostCapabilities } from './agent-host-capabilities'
import type { AgentHostPanelFocus } from './agent-host-panel-store'
import type { ResolvedAgentHost } from './use-agent-host'
import { openAgentHostSettings } from './open-agent-host-settings'

type WorkspaceSources =
  | { kind: 'loading' }
  | { kind: 'none' }
  | { kind: 'failed' }
  | { kind: 'ready'; view: AgentSourcesView }

function useWorkspaceSources(runtimeEnvironmentId: string | null): {
  sources: WorkspaceSources
  choose: (agent: OrcaCloudAccountAgent, source: Exclude<AgentSource, null>) => void
} {
  const t = useTranslate()
  const [sources, setSources] = useState<WorkspaceSources>({ kind: 'loading' })
  useEffect(() => {
    const api = window.api.orcaCloudAgents
    if (!api || !runtimeEnvironmentId) {
      setSources({ kind: 'none' })
      return
    }
    let cancelled = false
    void api
      .workspaceSources({ runtimeEnvironmentId })
      .then((result) => {
        if (!cancelled) {
          setSources(
            result.ok
              ? { kind: 'ready', view: result.value }
              : { kind: result.error === 'not_found' ? 'none' : 'failed' }
          )
        }
      })
      .catch(() => !cancelled && setSources({ kind: 'failed' }))
    return () => {
      cancelled = true
    }
  }, [runtimeEnvironmentId])
  const choose = useCallback(
    (agent: OrcaCloudAccountAgent, source: Exclude<AgentSource, null>) => {
      const api = window.api.orcaCloudAgents
      if (!api || !runtimeEnvironmentId) {
        return
      }
      void api
        .setWorkspaceSource({ agent, source, runtimeEnvironmentId })
        .then((result) => {
          if (result.ok) {
            setSources({ kind: 'ready', view: result.value })
          } else {
            toast.error(
              t('vmBuildAgents.menu.saveFailed', 'Couldn’t change it. Nothing was changed.')
            )
          }
        })
        .catch(() => undefined)
    },
    [runtimeEnvironmentId, t]
  )
  return { sources, choose }
}

export function useCloudHostPanelBody(
  host: ResolvedAgentHost,
  capabilities: AgentHostCapabilities,
  focus: AgentHostPanelFocus | undefined
): { agents: React.ReactNode; cloudSections: React.ReactNode } {
  const t = useTranslate()
  const accounts = useOrcaCloudAgentAccounts()
  const repoKey = host.cloud?.repoKey ?? null
  const asleep = host.availability === 'asleep'
  const { sources, choose } = useWorkspaceSources(host.environmentId)
  const sections = useCloudPanelSections({
    repoKey,
    runtimeEnvironmentId: host.environmentId,
    asleep
  })
  const { model: keysModel, saveDesktopKey } = useCloudAgentSetup({
    repo: repoKey,
    runtimeEnvironmentId: host.environmentId
  })
  const desktopKeys = keysModel.status === 'ready' ? keysModel.desktopKeys : []

  const load: CloudAgentsPanelLoad = useMemo(() => {
    switch (accounts.load.kind) {
      case 'loading':
        return { kind: 'loading' }
      case 'unavailable':
        return { kind: 'failed' }
      case 'failed':
        return accounts.load.error === 'signed_out' ? { kind: 'signedOut' } : { kind: 'failed' }
      case 'ready':
        return {
          kind: 'ready',
          rows: cloudAgentPanelRows(
            accounts.load.status,
            accounts.keyKinds,
            sources.kind === 'ready' ? sources.view : null
          )
        }
    }
  }, [accounts.load, accounts.keyKinds, sources])

  const shared = sources.kind === 'ready' && sources.view.sharedWorkspace === true
  const sourceDisabledReason =
    capabilities.actionsDisabledReason ??
    (shared
      ? t('agentSources.shared', 'Personal accounts aren’t used in shared workspaces.')
      : sources.kind === 'failed'
        ? t('vmBuildAgents.menu.failed', 'Couldn’t read this workspace’s choice.')
        : sources.kind === 'none'
          ? t('vmBuildAgents.menu.notYet', 'You can choose once the sandbox is created.')
          : null)

  const agents = (
    <CloudAgentsPanelSection
      title={capabilities.agents.title}
      help={capabilities.agents.help}
      load={load}
      sourceDisabledReason={sourceDisabledReason}
      actions={{
        chooseSource: choose,
        manage: () => openAgentHostSettings('agentAccounts'),
        signIn: () =>
          void useAppStore
            .getState()
            .connectCurrentOrcaProfile()
            .then(() => reloadOrcaCloudAgentAccounts()),
        retry: () => void reloadOrcaCloudAgentAccounts()
      }}
    />
  )
  // Signed out of Orca: one notice in section 1; Cloud secrets can't be read either.
  // W6's two sections under section 1.
  const cloudSections =
    load.kind === 'signedOut' ? null : (
      <>
        <CloudAgentKeysSection
          load={sections.load}
          onEdit={() => openAgentHostSettings('cloudSecrets')}
          onManage={() => openAgentHostSettings('cloudSecrets')}
          onRetry={sections.reload}
          extraRows={
            desktopKeys.length > 0 ? (
              <li className="py-2.5">
                <CloudDesktopKeysOffer keys={desktopKeys} onSave={saveDesktopKey} />
              </li>
            ) : undefined
          }
        />
        <CloudEnvironmentPanelSection
          load={sections.load}
          onRetry={sections.reload}
          onAdd={sections.addSecret}
          focusSecret={typeof focus === 'object' ? focus.secret : undefined}
          // One read feeds both sections, so section 2 alone shows (and announces) its error.
          showLoadError={false}
        />
      </>
    )
  return { agents, cloudSections }
}
