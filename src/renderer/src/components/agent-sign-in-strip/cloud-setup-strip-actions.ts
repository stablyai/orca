// What the "not set up" strip's buttons do. Set up once runs the one-time setup for the agent (the
// same flow as Settings › Orca Cloud › Cloud agent sign-ins); Start releases the held launch. Cancel during a
// setup stops only that setup: the launch stays held on "Set up once", and a setup finished from
// anywhere (here or Settings) turns the strip into "Start". Cancel with no setup running gives up
// the held launch and opens a plain shell, like cancelling any held launch.
import {
  releaseCloudAgentHold,
  startCloudAgentHold
} from '@/lib/orca-cloud/cloud-agent-launch-hold'
import {
  reloadOrcaCloudAgentAccounts,
  runOrcaCloudAgentSetups,
  setOrcaCloudAgentDefaultSource,
  stopOrcaCloudAgentSetups
} from '@/lib/orca-cloud/orca-cloud-agent-accounts-store'
import type { HostAgentSignInAgent } from '../../../../shared/host-agent-sign-in-status'
import type { CloudStripActions } from './CloudAgentSignInStrip'
import { requireLink } from '@/components/open-external/copy-external-link'

export function cloudSetupStripActions(args: {
  agent: HostAgentSignInAgent
  /** The hold's key: the pane, or the tab for a host-published launch. */
  holdKey: string
  setupRunning: boolean
  copyText: (text: string) => void
  openLink: (url: string) => void
  useApiKey: () => void
  /**
   * A structured chat has no plain shell to fall back to, so Cancel only stops a
   * running setup and the chat stays held on its strip. Closing the chat gives the launch up.
   */
  keepHoldOnCancel?: boolean
  /** The choice wasn't saved (nothing changed; the strip stays on "Set up once"). */
  onSaveFailed?: () => void
}): CloudStripActions {
  const { agent, holdKey } = args
  const api = window.api?.orcaCloudAgents
  return {
    primary: (action) => {
      if (action.kind === 'setUpOnce') {
        runOrcaCloudAgentSetups([agent])
      } else if (action.kind === 'reopenSetup') {
        void api?.reopen({ agent })
      } else if (action.kind === 'copyAndOpen') {
        args.copyText(action.code)
        args.openLink(action.url)
      } else if (action.kind === 'start') {
        // Start reads the account again; a revoked sign-in shows Renew instead.
        void startCloudAgentHold(holdKey)
      } else if (action.kind === 'signInInsideWorkspace') {
        // Remembered for this person and agent. The saved reply releases every launch held on "Set up
        // once" for the agent, and each starts as it is, asking for its own sign-in in the pane.
        void setOrcaCloudAgentDefaultSource(agent, 'in-workspace').then((error) => {
          if (error) {
            args.onSaveFailed?.()
          }
        })
      }
    },
    submitCode: (token) => {
      void api
        ?.pasteClaudeToken({ token })
        .then(() => reloadOrcaCloudAgentAccounts())
        .catch(() => undefined)
    },
    submitSetupCode: (code) => {
      // The CLI's answer comes back as a setup update (checking, then saved or rejected).
      void api?.submitClaudeCode({ code }).catch(() => undefined)
    },
    // "Copy link" beside "Open again": the provider page main would reopen, minted the same way.
    linkFor: (action) =>
      action.kind === 'reopenSetup' && api
        ? () => api.signInLink({ agent }).then(requireLink)
        : null,
    useCode: () => undefined,
    pasteCode: () => void api?.usePaste(),
    useApiKey: args.useApiKey,
    cancel: () => {
      if (args.setupRunning) {
        // Only the sign-in is abandoned; the person may still set up (here or in Settings) and start.
        stopOrcaCloudAgentSetups(agent)
        return
      }
      if (args.keepHoldOnCancel) {
        return
      }
      releaseCloudAgentHold(holdKey, 'cancel')
    }
  }
}
