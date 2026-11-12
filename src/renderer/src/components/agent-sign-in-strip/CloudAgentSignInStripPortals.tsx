// Orca Cloud panes get the strip instead of #40228's centred card: account recovery (S4-c) while the
// private launch hold waits, or #40228's per-workspace gate while the Orca-account path is paused or
// never offered. It overlays the top 56 px of the pane while the agent hasn't started, so the
// terminal's size never changes. SSH, WSL and paired hosts keep #40228's card.
import { openOrcaCloudSignInSheet } from '@/components/settings/agent-accounts/sign-in-sheet/orca-cloud-sign-in-sheet-store'
import React, { useEffect, useSyncExternalStore } from 'react'
import { createPortal } from 'react-dom'
import { useAppStore } from '@/store'
import { useTranslate } from '@/i18n/use-translate'
import { makePaneKey } from '../../../../shared/workspace-layout/stable-pane-id'
import { isOrcaCloudEnvironmentId } from '@/lib/orca-cloud/orca-cloud-environment-id'
import type { ManagedPane } from '@/lib/pane-manager/pane-manager-types'
import {
  readAgentSignInGate,
  subscribeAgentSignInGates,
  useAgentSignInGate
} from '@/lib/agent-sign-in/agent-sign-in-gate-store'
import { abandonAgentSignIn } from '@/lib/agent-sign-in/agent-sign-in-gate'
import {
  cloudAgentHoldReason,
  cloudAgentStripReason,
  cloudTabHoldKey,
  readCloudAgentHold,
  releaseCloudAgentHold,
  useCloudAgentHold
} from '@/lib/orca-cloud/cloud-agent-launch-hold'
import { useOrcaCloudAgentAccounts } from '@/lib/orca-cloud/orca-cloud-agent-accounts-store'
import type { TerminalPaneController } from '../terminal-pane/controller/use-terminal-pane-controller'
import { agentSignInCardActions } from '../agent-sign-in/AgentSignInPanePortals'
import {
  CloudAgentSignInStrip,
  CloudStripLayer,
  cloudStripWidth,
  type CloudStripActions
} from './CloudAgentSignInStrip'
import { cloudAgentStripModel } from './cloud-agent-strip-model'
import { cloudAgentSetupStripModel } from './cloud-agent-setup-strip-model'
import { cloudSetupStripActions } from './cloud-setup-strip-actions'
import { CloudRunningStripPortal } from './CloudRunningStripPortal'

const ABANDON_CHECK_MS = 1_000

/**
 * NOACCT-MISLABEL: a held launch is given up only when its tab is really gone (closed). A pane that
 * unmounts because its workspace is off screen (parked, another workspace, Settings) keeps waiting:
 * its strip and the sidebar mark come back with it. Cancelling it there showed "The agent didn't
 * start" for a create whose agent simply isn't set up.
 */
export function shouldAbandonCloudHold(args: {
  paneConnected: boolean
  tabOpen: boolean
}): boolean {
  return !args.paneConnected && !args.tabOpen
}

function isTabOpen(tabId: string): boolean {
  const tabsByWorktree = useAppStore.getState().tabsByWorktree
  return Object.values(tabsByWorktree).some((tabs) => tabs?.some((tab) => tab.id === tabId))
}

export { isOrcaCloudEnvironmentId }

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

function openSettings(pane: 'cloud-secrets', sectionId?: string): void {
  const store = useAppStore.getState()
  store.openSettingsTarget({ pane, repoId: null, ...(sectionId ? { sectionId } : {}) })
  store.openSettingsPage()
}

function CloudStripPortal({
  pane,
  tabId,
  first
}: {
  pane: ManagedPane
  tabId: string
  /** A host-published launch holds its whole tab (RA-1); its first pane shows the strip. */
  first: boolean
}): React.JSX.Element | null {
  const t = useTranslate()
  const paneKey = makePaneKey(tabId, pane.leafId)
  const paneHold = useCloudAgentHold(paneKey)
  const tabHold = useCloudAgentHold(first ? cloudTabHoldKey(tabId) : '')
  const hold = paneHold ?? tabHold
  // Releases and abandons go to whichever key holds; #40228's gate is always per pane.
  const key = paneHold || !tabHold ? paneKey : cloudTabHoldKey(tabId)
  const gate = useAgentSignInGate(paneKey)
  const cloudGate = gate && isOrcaCloudEnvironmentId(gate.environmentId) ? gate : null
  const accounts = useOrcaCloudAgentAccounts(hold !== null || cloudGate !== null)
  // The first render's class; the strip then follows its own live width (RA-1).
  const width = cloudStripWidth(pane.container.clientWidth)
  const active = hold !== null || cloudGate !== null
  useEffect(() => {
    if (!active) {
      return
    }
    // A remount unmounts the portal too; only a pane that stays gone gives up its sign-in.
    return () => {
      setTimeout(() => {
        if (!pane.container.isConnected) {
          if (
            readCloudAgentHold(key) &&
            shouldAbandonCloudHold({ paneConnected: false, tabOpen: isTabOpen(tabId) })
          ) {
            releaseCloudAgentHold(key, 'cancel')
          }
          if (readAgentSignInGate(paneKey)) {
            abandonAgentSignIn(paneKey)
          }
        }
      }, ABANDON_CHECK_MS)
    }
  }, [active, key, paneKey, pane.container, tabId])
  if (!hold && !cloudGate) {
    return null
  }
  const agent = hold?.agent ?? cloudGate?.agent ?? 'claude'
  const reason = hold
    ? 'accountExpired'
    : (cloudAgentStripReason(agent, accounts) ?? 'paused') === 'notOffered'
      ? 'notOffered'
      : 'paused'
  const gateActions = agentSignInCardActions(paneKey)
  // PC-3b: a launch held because the agent isn't set up runs the one-time setup in the pane.
  const setupHold = hold?.reason === 'notSetUp'
  const setup = accounts.setups[agent]
  const model = setupHold
    ? cloudAgentSetupStripModel({
        agent,
        setup,
        ready: accounts.load.kind === 'ready' && cloudAgentHoldReason(agent, accounts) === null,
        t
      })
    : cloudAgentStripModel({
        agent,
        reason,
        view: hold ? null : (cloudGate?.view ?? null),
        hostLabel: cloudGate?.hostLabel ?? t('agentSignInStrip.sandbox', 'the sandbox'),
        t
      })
  const holdActions: CloudStripActions | null = setupHold
    ? cloudSetupStripActions({
        agent,
        holdKey: key,
        setupRunning: setup.phase !== 'idle' && setup.phase !== 'saved' && setup.phase !== 'failed',
        copyText: gateActions.copyText,
        openLink: gateActions.openLink,
        useApiKey: () => openSettings('cloud-secrets')
      })
    : null
  const actions: CloudStripActions = holdActions ?? {
    primary: (action) => {
      // RA-11's restart belongs to the running-pane strip; a held launch never offers it.
      if (
        action.kind === 'restart' ||
        action.kind === 'setUpOnce' ||
        action.kind === 'reopenSetup' ||
        action.kind === 'start'
      ) {
        return
      }
      switch (action.kind) {
        case 'renew':
          openOrcaCloudSignInSheet()
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
    <CloudStripLayer>
      <CloudAgentSignInStrip
        model={model}
        prompt={hold?.prompt ?? cloudGate?.prompt ?? null}
        width={width}
        actions={actions}
      />
    </CloudStripLayer>,
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
      {controller.managedPanes.map((pane, index) => (
        <React.Fragment key={pane.id}>
          <CloudStripPortal pane={pane} tabId={controller.tabId} first={index === 0} />
          <CloudRunningStripPortal
            pane={pane}
            tabId={controller.tabId}
            worktreeId={controller.worktreeId}
          />
        </React.Fragment>
      ))}
    </>
  )
}
