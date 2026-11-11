// Live Agents row for an Orca Cloud build. Reads the Orca account once (shared store with S0 and the
// composer), never the sandbox; runs S0's setup inline when nothing is set up (R2), and writes the
// per-workspace Source from the ⋯ menu (S1-b).
import { openOrcaCloudSignInSheet } from '@/components/settings/agent-accounts/sign-in-sheet/orca-cloud-sign-in-sheet-store'
import React, { useCallback, useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { useAppStore } from '@/store'
import { useTranslate } from '@/i18n/use-translate'
import {
  reloadOrcaCloudAgentAccounts,
  runOrcaCloudAgentSetups,
  stopOrcaCloudAgentSetups,
  useOrcaCloudAgentAccounts
} from '@/lib/orca-cloud/orca-cloud-agent-accounts-store'
import {
  buildAgentsRow,
  buildAgentsRowDensity,
  buildAgentsToSetUp,
  type BuildAgentsRowDensity
} from '@/lib/orca-cloud/orca-cloud-build-agents-row'
import {
  startVmBuildAgentSignIn,
  useVmBuildAgentSignIn
} from '@/lib/agent-sign-in/vm-build-agent-sign-in'
import type { PendingWorktreeCreation } from '@/lib/workspace/creation/pending-worktree-creation'
import type {
  AgentSource,
  OrcaCloudAccountAgent
} from '../../../../../shared/orca-cloud-agents/orca-cloud-agents-wire'
import { useCloudAgentSetup } from '../../cloud-agent-setup/use-cloud-agent-setup'
import { cloudSecretRepoKey } from '../../settings/cloud-secrets/cloud-secret-repos'
import { VmBuildAgentSignInRow } from '../VmBuildAgentSignInRow'
import { VmBuildCloudAgentsMenu, type WorkspaceSourcesLoad } from './VmBuildCloudAgentsMenu'
import { VmBuildCloudAgentsRowView, type DesktopKeySave } from './VmBuildCloudAgentsRowView'

function openSettings(pane: 'cloud-secrets', sectionId?: string): void {
  const store = useAppStore.getState()
  store.openSettingsTarget({ pane, repoId: null, ...(sectionId ? { sectionId } : {}) })
  store.openSettingsPage()
}

export function VmBuildCloudAgentsRow({
  creationId,
  entry
}: {
  creationId: string
  entry: PendingWorktreeCreation
}): React.JSX.Element | null {
  const t = useTranslate()
  const accounts = useOrcaCloudAgentAccounts()
  const environmentId = entry.vmEnvironmentId ?? null
  const runtimeEnvironmentId =
    environmentId ?? entry.request.ephemeralVmRuntimeEnvironmentId ?? null
  const repoKey = useAppStore((s) => {
    const repo = s.repos.find((candidate) => candidate.id === entry.request.repoId)
    return repo ? cloudSecretRepoKey(repo) : null
  })
  const { model: keysModel, saveDesktopKey } = useCloudAgentSetup({
    repo: repoKey,
    runtimeEnvironmentId: environmentId
  })
  const desktopKeys = keysModel.status === 'ready' ? keysModel.desktopKeys : []
  const model = buildAgentsRow({ accounts, desktopKeys })
  // Decided on the first render and never re-derived (redesign §5, AC-3).
  const [density] = useState<BuildAgentsRowDensity>(() => buildAgentsRowDensity(model))

  const [desktopKeySave, setDesktopKeySave] = useState<DesktopKeySave>({ kind: 'idle' })
  const saveKey = useCallback(() => {
    if (model.kind !== 'desktopKey') {
      return
    }
    setDesktopKeySave({ kind: 'saving' })
    void saveDesktopKey(model.key).then((error) => {
      setDesktopKeySave(error ? { kind: 'failed', error } : { kind: 'idle' })
      if (!error) {
        // The saved key now covers the agent: the row becomes the ready line.
        void reloadOrcaCloudAgentAccounts()
      }
    })
  }, [model, saveDesktopKey])

  // §5c: a per-workspace sign-in. Pressed before the sandbox answers, it waits for it (R3); each
  // press is its own request, so a cancelled one never starts later.
  const [signInHere, setSignInHere] = useState<{
    agent: OrcaCloudAccountAgent
    request: number
  } | null>(null)
  const startedRequest = useRef(0)
  const nextRequest = useRef(0)
  const hostLabel = useAppStore(
    (s) => s.runtimeEnvironments.find((environment) => environment.id === environmentId)?.name
  )
  useEffect(() => {
    if (!signInHere || !environmentId || startedRequest.current === signInHere.request) {
      return
    }
    startedRequest.current = signInHere.request
    void startVmBuildAgentSignIn(creationId, environmentId, hostLabel ?? environmentId, [
      signInHere.agent
    ])
  }, [signInHere, environmentId, creationId, hostLabel])
  const queued = signInHere !== null && !environmentId
  const signInRun = useVmBuildAgentSignIn(creationId, environmentId ?? '')

  const [sources, setSources] = useState<WorkspaceSourcesLoad>({ kind: 'loading' })
  const readSources = useCallback(() => {
    const api = window.api.orcaCloudAgents
    if (!api || !runtimeEnvironmentId) {
      setSources({ kind: 'none' })
      return
    }
    void api
      .workspaceSources({ runtimeEnvironmentId })
      .then((result) =>
        setSources(
          result.ok
            ? { kind: 'ready', view: result.value }
            : { kind: result.error === 'not_found' ? 'none' : 'failed' }
        )
      )
      .catch(() => setSources({ kind: 'failed' }))
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
            // This workspace only; the account-wide defaults the store holds are unchanged.
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

  if (model.kind === 'hidden' || entry.status === 'error') {
    return null
  }
  const api = window.api.orcaCloudAgents
  const status = accounts.load.kind === 'ready' ? accounts.load.status : null
  const menu =
    model.kind === 'loading' || model.kind === 'setup' ? undefined : (
      <VmBuildCloudAgentsMenu
        offer={model.kind === 'offer' || model.kind === 'desktopKey'}
        status={status}
        keyKinds={accounts.keyKinds}
        sources={sources}
        onOpen={readSources}
        onChoose={choose}
        onManage={() => openOrcaCloudSignInSheet()}
        onUseKey={() => openSettings('cloud-secrets')}
      />
    )
  return (
    <>
      <VmBuildCloudAgentsRowView
        model={model}
        density={density}
        menu={menu}
        desktopKeySave={desktopKeySave}
        queued={queued}
        actions={{
          setUp: () => runOrcaCloudAgentSetups(buildAgentsToSetUp(model)),
          cancel: (agent) => stopOrcaCloudAgentSetups(agent),
          reopen: (agent) => void api?.reopen({ agent }),
          copyCodeAndOpen: (agent, code) => {
            void window.api.ui
              .writeClipboardText(code)
              .then(() => toast.success(t('vmBuildAgents.codeCopied', 'Code copied')))
              .catch(() => undefined)
            void api?.reopen({ agent })
          },
          dismissFailure: (agent) => {
            stopOrcaCloudAgentSetups()
            void api?.acknowledge({ agent })
          },
          retryLoad: () => void reloadOrcaCloudAgentAccounts(),
          manage: () => openOrcaCloudSignInSheet(),
          saveDesktopKey: saveKey,
          signInHere: (agent) => {
            nextRequest.current += 1
            setSignInHere({ agent, request: nextRequest.current })
          },
          cancelSignInHere: () => setSignInHere(null)
        }}
      />
      {/* §5c only: the per-workspace sign-in's browser and code steps, once it has started. */}
      {model.kind === 'killSwitch' && environmentId && signInRun ? (
        <VmBuildAgentSignInRow creationId={creationId} environmentId={environmentId} />
      ) : null}
    </>
  )
}
