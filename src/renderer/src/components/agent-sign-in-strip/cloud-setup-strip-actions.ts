// PC-3b: what the "not set up" strip's buttons do. Set up once runs S0's setup for the agent (the
// same flow as Settings › Accounts › Orca Cloud); Start releases the held launch. Cancel during a
// setup stops only that setup: the launch stays held on "Set up once", and a setup finished from
// anywhere (here or Settings) turns the strip into "Start". Cancel with no setup running gives up
// the held launch and opens a plain shell, like cancelling any held launch (RR-a).
import { releaseCloudAgentHold } from '@/lib/orca-cloud/cloud-agent-launch-hold'
import {
  reloadOrcaCloudAgentAccounts,
  runOrcaCloudAgentSetups,
  stopOrcaCloudAgentSetups
} from '@/lib/orca-cloud/orca-cloud-agent-accounts-store'
import type { HostAgentSignInAgent } from '../../../../shared/host-agent-sign-in-status'
import type { CloudStripActions } from './CloudAgentSignInStrip'

export function cloudSetupStripActions(args: {
  agent: HostAgentSignInAgent
  /** The hold's key: the pane, or the tab for a host-published launch. */
  holdKey: string
  setupRunning: boolean
  copyText: (text: string) => void
  openLink: (url: string) => void
  useApiKey: () => void
}): CloudStripActions {
  const { agent, holdKey } = args
  const api = window.api.orcaCloudAgents
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
        releaseCloudAgentHold(holdKey, 'proceed')
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
    useCode: () => undefined,
    pasteCode: () => void api?.usePaste(),
    useApiKey: args.useApiKey,
    cancel: () => {
      if (args.setupRunning) {
        // Only the sign-in is abandoned; the person may still set up (here or in Settings) and start.
        stopOrcaCloudAgentSetups(agent)
        return
      }
      releaseCloudAgentHold(holdKey, 'cancel')
    }
  }
}
