// Orca Cloud panes get the strip instead of #40228's centred card: account recovery (S4-c) while the
// private launch hold waits, or #40228's per-workspace gate while the Orca-account path is paused or
// never offered. It overlays the top 56 px of the pane while the agent hasn't started, so the
// terminal's size never changes. SSH, WSL and paired hosts keep #40228's card.
import React, { useEffect, useState, useSyncExternalStore } from 'react'
import { createPortal } from 'react-dom'
import { useAppStore } from '@/store'
import { useTranslate } from '@/i18n/use-translate'
import { makePaneKey } from '../../../../shared/workspace-layout/stable-pane-id'
import { isOrcaCloudRuntimeEnvironment } from '../../../../shared/remote-runtime/host-catalog/orca-cloud-environment-name'
import type { ManagedPane } from '@/lib/pane-manager/pane-manager-types'
import {
  readAgentSignInGate,
  subscribeAgentSignInGates,
  useAgentSignInGate
} from '@/lib/agent-sign-in/agent-sign-in-gate-store'
import { abandonAgentSignIn } from '@/lib/agent-sign-in/agent-sign-in-gate'
import {
  cloudAgentStripReason,
  readCloudAgentHold,
  releaseCloudAgentHold,
  useCloudAgentHold
} from '@/lib/orca-cloud/cloud-agent-launch-hold'
import { useOrcaCloudAgentAccounts } from '@/lib/orca-cloud/orca-cloud-agent-accounts-store'
import type { TerminalPaneController } from '../terminal-pane/controller/use-terminal-pane-controller'
import { agentSignInCardActions } from '../agent-sign-in/AgentSignInPanePortals'
import {
  CloudAgentSignInStrip,
  cloudStripWidth,
  type CloudStripActions
} from './CloudAgentSignInStrip'
import { cloudAgentStripModel } from './cloud-agent-strip-model'

const ABANDON_CHECK_MS = 1_000

export function isOrcaCloudEnvironmentId(environmentId: string): boolean {
  const environment = useAppStore
    .getState()
    .runtimeEnvironments?.find((entry) => entry.id === environmentId)
  return environment ? isOrcaCloudRuntimeEnvironment(environment) : false
}

/** Pane keys whose #40228 gate is on an Orca Cloud host; those panes show the strip instead. */
export function useCloudGatePaneKeys(controller: TerminalPaneController): ReadonlySet<string> {
  const joined = useSyncExternalStore(subscribeAgentSignInGates, () =>
    controller.managedPanes
      .map((pane) => makePaneKey(controller.tabId, pane.leafId))
      .filter((key) => {
        const gate = readAgentSignInGate(key)
        return gate !== null && isOrcaCloudEnvironmentId(gate.environmentId)
      })
      .join('\u0000')
  )
  return new Set(joined ? joined.split('\u0000') : [])
}

function openSettings(pane: 'agent-accounts' | 'cloud-secrets', sectionId?: string): void {
  const store = useAppStore.getState()
  store.openSettingsTarget({ pane, repoId: null, ...(sectionId ? { sectionId } : {}) })
  store.openSettingsPage()
}

function CloudStripPortal({
  pane,
  tabId
}: {
  pane: ManagedPane
  tabId: string
}): React.JSX.Element | null {
  const t = useTranslate()
  const key = makePaneKey(tabId, pane.leafId)
  const hold = useCloudAgentHold(key)
  const gate = useAgentSignInGate(key)
  const cloudGate = gate && isOrcaCloudEnvironmentId(gate.environmentId) ? gate : null
  const accounts = useOrcaCloudAgentAccounts(hold !== null || cloudGate !== null)
  // Decided once at mount (container query); the strip never changes width class mid-flow.
  const [width] = useState(() => cloudStripWidth(pane.container.clientWidth))
  const active = hold !== null || cloudGate !== null
  useEffect(() => {
    if (!active) {
      return
    }
    // A remount unmounts the portal too; only a pane that stays gone gives up its sign-in.
    return () => {
      setTimeout(() => {
        if (!pane.container.isConnected) {
          if (readCloudAgentHold(key)) {
            releaseCloudAgentHold(key, 'cancel')
          }
          if (readAgentSignInGate(key)) {
            abandonAgentSignIn(key)
          }
        }
      }, ABANDON_CHECK_MS)
    }
  }, [active, key, pane.container])
  if (!hold && !cloudGate) {
    return null
  }
  const agent = hold?.agent ?? cloudGate?.agent ?? 'claude'
  const reason = hold
    ? 'accountExpired'
    : (cloudAgentStripReason(agent, accounts) ?? 'paused') === 'notOffered'
      ? 'notOffered'
      : 'paused'
  const model = cloudAgentStripModel({
    agent,
    reason,
    view: hold ? null : (cloudGate?.view ?? null),
    hostLabel: cloudGate?.hostLabel ?? t('agentSignInStrip.sandbox', 'the sandbox'),
    t
  })
  const gateActions = agentSignInCardActions(key)
  const actions: CloudStripActions = {
    primary: (action) => {
      switch (action.kind) {
        case 'renew':
          openSettings('agent-accounts', 'orca-cloud')
          return
        case 'signIn':
          gateActions.signIn()
          return
        case 'openAgain':
          gateActions.openLink(action.url)
          return
        case 'copyAndOpen':
          gateActions.copyText(action.code)
          gateActions.openLink(action.url)
          return
        case 'retry':
          gateActions.retry()
          return
        case 'useDeviceCode':
        case 'submitCode':
          gateActions.useCode()
      }
    },
    submitCode: gateActions.submitCode,
    pasteCode: gateActions.useCode,
    useCode: gateActions.useCode,
    useApiKey: () => openSettings('cloud-secrets'),
    cancel: () => (hold ? releaseCloudAgentHold(key, 'cancel') : gateActions.cancel())
  }
  return createPortal(
    <div className="absolute inset-x-0 top-0 z-20">
      <CloudAgentSignInStrip
        model={model}
        prompt={hold?.prompt ?? cloudGate?.prompt ?? null}
        width={width}
        actions={actions}
      />
    </div>,
    pane.container,
    `cloud-sign-in-strip-${pane.id}`
  )
}

export function CloudAgentSignInStripPortals({
  controller
}: {
  controller: TerminalPaneController
}): React.JSX.Element {
  return (
    <>
      {controller.managedPanes.map((pane) => (
        <CloudStripPortal key={pane.id} pane={pane} tabId={controller.tabId} />
      ))}
    </>
  )
}
