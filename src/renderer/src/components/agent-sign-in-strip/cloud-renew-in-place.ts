// CHAT-RENEW-INPLACE (Option A, design-squad per-step copy): every "sign-in expired" strip — a held
// launch, a running terminal, a structured chat — renews in place. Renew runs the same Orca Cloud
// setup as "Set up once" right in the strip (re-running it replaces the account's expired sign-in),
// instead of sending the person to Settings. One model and one set of actions for every surface, so
// the terminal and the chat can't drift apart.
//   1 expired: [Renew]                      2 browser: paste code, [Finish renewing] [Open again] ×
//   3 checking: field and buttons disabled  4 rejected: "Code didn't work", [Open again]
//   5 renewed: the surface's own renewed state (held: Start; terminal: Restart; chat: next message)
//   × mid-flow stops the setup and goes back to step 1; it never dismisses the strip.
import type { Translate } from '@/i18n/use-translate'
import { useAppStore } from '@/store'
import {
  runOrcaCloudAgentSetups,
  stopOrcaCloudAgentSetups
} from '@/lib/orca-cloud/orca-cloud-agent-accounts-store'
import type { OrcaCloudAgentSetup } from '../../../../shared/orca-cloud-agents/orca-cloud-agents-wire'
import type { HostAgentSignInAgent } from '../../../../shared/host-agent-sign-in-status'
import type { CloudStripActions } from './CloudAgentSignInStrip'
import type { CloudStripModel } from './cloud-agent-strip-model'
import { cloudAgentSetupStripModel } from './cloud-agent-setup-strip-model'
import { cloudSetupStripActions } from './cloud-setup-strip-actions'
import { agentSignInCardActions } from '../agent-sign-in/AgentSignInPanePortals'

/** The renewal's own setup is under way (steps 2-4): the strip shows it instead of step 1. */
export function renewInPlaceRunning(setup: OrcaCloudAgentSetup): boolean {
  return setup.phase !== 'idle' && setup.phase !== 'saved'
}

/**
 * Steps 1-4 over a surface's "expired" model (step 1 keeps the surface's own detail: running "Renew
 * to keep working…", held "Renew to start {{agent}}."). Step 5 is each surface's renewed state.
 */
export function cloudRenewInPlaceModel(args: {
  agent: HostAgentSignInAgent
  expired: CloudStripModel
  setup: OrcaCloudAgentSetup
  t: Translate
}): CloudStripModel {
  const { expired, setup, t } = args
  if (!renewInPlaceRunning(setup)) {
    return expired
  }
  const flow = cloudAgentSetupStripModel({ agent: args.agent, setup, ready: false, t })
  const settingsLink = t('agentSignInStrip.renewInSettings', 'Renew in Settings')
  // A failed setup keeps its own words; a refused code says "Code didn't work" (as #484).
  const keepsTitle =
    setup.phase === 'failed' || (setup.phase === 'browser' && setup.code === 'rejected')
  const finishRenewing = t('agentSignInStrip.finishRenewing', 'Finish renewing')
  const paste = flow.paste
    ? {
        ...flow.paste,
        // Never the setup's "Finish setup" (design-squad).
        ...(flow.paste.setupCode
          ? {
              setupCode: {
                ...flow.paste.setupCode,
                submitLabel:
                  setup.phase === 'browser' && setup.code === 'checking'
                    ? flow.paste.setupCode.submitLabel
                    : finishRenewing
              }
            }
          : {}),
        ...(flow.paste.submitLabel ? { submitLabel: finishRenewing } : {})
      }
    : null
  return {
    ...flow,
    title: keepsTitle ? flow.title : expired.title,
    paste,
    // A setup that failed outright starts again from Renew.
    primary:
      setup.phase === 'failed' && flow.primary?.action.kind === 'setUpOnce'
        ? { ...flow.primary, action: { kind: 'renew' } }
        : flow.primary,
    ...(setup.phase === 'browser' || setup.phase === 'paste' ? { settingsLink } : {}),
    announcement: keepsTitle ? flow.announcement : `${expired.title}. ${flow.announcement}`
  }
}

/**
 * Renew starts the setup here; Open again, the code and the paste go to it; × stops it (back to
 * step 1). With no renewal running, everything else is the surface's own (its × or Restart).
 */
export function cloudRenewInPlaceActions(args: {
  agent: HostAgentSignInAgent
  setup: OrcaCloudAgentSetup
  /** The surface's own actions, used outside the renewal (Restart, a renewed strip's ×). */
  surface: CloudStripActions
  /** "Renew in Settings": the same renewal in Settings › Accounts › Orca Cloud. */
  openSettings: () => void
  copyText: (text: string) => void
  openLink: (url: string) => void
}): CloudStripActions {
  const running = renewInPlaceRunning(args.setup)
  const flow = cloudSetupStripActions({
    agent: args.agent,
    // Renewing holds nothing itself: Start (step 5) belongs to the surface.
    holdKey: '',
    setupRunning: running,
    copyText: args.copyText,
    openLink: args.openLink,
    useApiKey: args.surface.useApiKey,
    keepHoldOnCancel: true
  })
  return {
    ...args.surface,
    primary: (action) => {
      if (action.kind === 'renew') {
        runOrcaCloudAgentSetups([args.agent])
      } else if (action.kind === 'reopenSetup' || action.kind === 'copyAndOpen') {
        flow.primary(action)
      } else {
        args.surface.primary(action)
      }
    },
    submitCode: running ? flow.submitCode : args.surface.submitCode,
    submitSetupCode: flow.submitSetupCode,
    // "Copy link" beside Open again: the renewal's sign-in page, as for "Set up once".
    linkFor: running ? flow.linkFor : args.surface.linkFor,
    pasteCode: running ? flow.pasteCode : args.surface.pasteCode,
    openSettings: args.openSettings,
    cancel: () => (running ? stopOrcaCloudAgentSetups(args.agent) : args.surface.cancel())
  }
}

/** "Renew in Settings": Settings › Accounts › Orca Cloud, where the same renewal runs. */
export function openOrcaCloudAccountsSettings(): void {
  const store = useAppStore.getState()
  store.openSettingsTarget({ pane: 'accounts', repoId: null, sectionId: 'orca-cloud' })
  store.openSettingsPage()
}

/** A surface's expired strip, renewing in place: its model (steps 1-4) and actions together. */
export function withRenewInPlace(args: {
  agent: HostAgentSignInAgent
  setup: OrcaCloudAgentSetup
  model: CloudStripModel
  actions: CloudStripActions
  /** The pane or chat key, for the sign-in page's copy and open. */
  key: string
  t: Translate
}): { model: CloudStripModel; actions: CloudStripActions } {
  const page = agentSignInCardActions(args.key)
  return {
    model: cloudRenewInPlaceModel({
      agent: args.agent,
      expired: args.model,
      setup: args.setup,
      t: args.t
    }),
    actions: cloudRenewInPlaceActions({
      agent: args.agent,
      setup: args.setup,
      surface: args.actions,
      openSettings: openOrcaCloudAccountsSettings,
      copyText: page.copyText,
      openLink: page.openLink
    })
  }
}
