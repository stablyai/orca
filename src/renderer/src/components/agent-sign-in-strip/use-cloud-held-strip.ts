// The held-launch strip for one pane key: account recovery (S4-c), "Set up once" (PC-3b), or
// #40228's per-workspace gate on an Orca Cloud host. Shared by a terminal pane's strip and a structured
// chat's (CHAT-BANNERS), so both read the same hold and act the same way.
import { openOrcaCloudSignInSheet } from '@/components/settings/agent-accounts/sign-in-sheet/orca-cloud-sign-in-sheet-store'
import { useAppStore } from '@/store'
import { useTranslate } from '@/i18n/use-translate'
import { isOrcaCloudEnvironmentId } from '@/lib/orca-cloud/orca-cloud-environment-id'
import { useAgentSignInGate } from '@/lib/agent-sign-in/agent-sign-in-gate-store'
import {
  cloudAgentHoldReason,
  cloudAgentStripReason,
  releaseCloudAgentHold,
  useCloudAgentHold
} from '@/lib/orca-cloud/cloud-agent-launch-hold'
import { useOrcaCloudAgentAccounts } from '@/lib/orca-cloud/orca-cloud-agent-accounts-store'
import { agentSignInCardActions } from '../agent-sign-in/AgentSignInPanePortals'
import type { CloudStripActions } from './CloudAgentSignInStrip'
import { cloudAgentStripModel, type CloudStripModel } from './cloud-agent-strip-model'
import {
  cloudAgentAwaitingStartStripModel,
  cloudAgentSetupStripModel
} from './cloud-agent-setup-strip-model'
import { cloudSetupStripActions } from './cloud-setup-strip-actions'

export type CloudHeldStrip = {
  model: CloudStripModel
  prompt: string | null
  actions: CloudStripActions
}

function openSettings(pane: 'cloud-secrets', sectionId?: string): void {
  const store = useAppStore.getState()
  store.openSettingsTarget({ pane, repoId: null, ...(sectionId ? { sectionId } : {}) })
  store.openSettingsPage()
}

/**
 * The strip a held launch (or a cloud gate) shows for this pane key; tabHoldKey also reads a hold on
 * the whole tab (RA-1). key: whichever key holds, for releases and abandons.
 */
export function useCloudHeldStrip(
  paneKey: string,
  tabHoldKey: string | null,
  /** A structured chat's hold: Cancel never gives it up (closing the chat does). */
  { chat = false }: { chat?: boolean } = {}
): { key: string; active: boolean; strip: CloudHeldStrip | null } {
  const t = useTranslate()
  const paneHold = useCloudAgentHold(paneKey)
  const tabHold = useCloudAgentHold(tabHoldKey ?? '')
  const hold = paneHold ?? tabHold
  // Releases and abandons go to whichever key holds; #40228's gate is always per pane.
  const key = paneHold || !tabHold || !tabHoldKey ? paneKey : tabHoldKey
  const gate = useAgentSignInGate(paneKey)
  const cloudGate = gate && isOrcaCloudEnvironmentId(gate.environmentId) ? gate : null
  const accounts = useOrcaCloudAgentAccounts(hold !== null || cloudGate !== null)
  const active = hold !== null || cloudGate !== null
  if (!hold && !cloudGate) {
    return { key, active, strip: null }
  }
  const agent = hold?.agent ?? cloudGate?.agent ?? 'claude'
  const reason = hold
    ? 'accountExpired'
    : (cloudAgentStripReason(agent, accounts) ?? 'paused') === 'notOffered'
      ? 'notOffered'
      : 'paused'
  const gateActions = agentSignInCardActions(paneKey)
  // PC-3b: a launch held because the agent isn't set up runs the one-time setup in the pane.
  const awaiting = hold?.reason === 'awaitingStart' ? (hold.awaiting ?? 'unread') : null
  // V3-01: a restored hold waiting for Start shares the setup hold's actions (Start, cancel).
  const setupHold = hold?.reason === 'notSetUp' || awaiting !== null
  const setup = accounts.setups[agent]
  // HELD-STALE-COVERED: the setup just finished here: "is set up · Start" (the account, read fresh).
  const model =
    awaiting === 'setUp'
      ? cloudAgentSetupStripModel({ agent, setup: accounts.setups[agent], ready: true, t })
      : awaiting
        ? cloudAgentAwaitingStartStripModel({
            agent,
            awaiting,
            queuedPrompt: Boolean(hold?.prompt),
            t
          })
        : setupHold
          ? cloudAgentSetupStripModel({
              agent,
              setup,
              ready:
                accounts.load.kind === 'ready' && cloudAgentHoldReason(agent, accounts) === null,
              t
            })
          : cloudAgentStripModel({
              agent,
              reason,
              view: hold ? null : (cloudGate?.view ?? null),
              hostLabel: cloudGate?.hostLabel ?? t('agentSignInStrip.sandbox', 'the sandbox'),
              t
            })
  const setupRunning = setup.phase !== 'idle' && setup.phase !== 'saved' && setup.phase !== 'failed'
  const holdActions: CloudStripActions | null = setupHold
    ? cloudSetupStripActions({
        agent,
        holdKey: key,
        setupRunning,
        copyText: gateActions.copyText,
        openLink: gateActions.openLink,
        useApiKey: () => openSettings('cloud-secrets'),
        keepHoldOnCancel: chat
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
    cancel: () => {
      if (!hold) {
        gateActions.cancel()
      } else if (!chat) {
        releaseCloudAgentHold(key, 'cancel')
      }
    }
  }
  // A held chat's strip has nothing to cancel unless a setup is running: no × (Escape is a no-op).
  const shownModel =
    chat && hold && !(setupHold && setupRunning) ? { ...model, noClose: true } : model
  return {
    key,
    active,
    strip: { model: shownModel, prompt: hold?.prompt ?? cloudGate?.prompt ?? null, actions }
  }
}
