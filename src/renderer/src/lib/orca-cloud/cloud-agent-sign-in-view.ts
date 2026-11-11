// What the agent prompt toast says while the S0 sign-in runs (split from
// cloud-agent-not-started-toast so that file stays within its size budget).
import { translate } from '@/i18n/i18n'
import { openOrcaCloudAgentAccounts } from '@/components/new-workspace/OrcaCloudAgentSetupRow'
import {
  agentName,
  setupFailureCopy
} from '@/components/settings/agent-accounts/orca-cloud-accounts-copy'
import type {
  OrcaCloudAccountAgent,
  OrcaCloudAgentSetup
} from '../../../../shared/orca-cloud-agents/orca-cloud-agents-wire'

export type ToastView = {
  message: string
  description?: string
  /** `primary`: the next required step (design-squad's toast chrome, DS-q). */
  action?: { label: string; run: () => void; primary?: boolean }
}

function deviceHost(url: string): string {
  try {
    return new URL(url).hostname
  } catch {
    return url
  }
}

/** What the toast says while the S0 sign-in runs; null while it is idle (the plain prompt). */
export function cloudAgentSignInView(
  agent: OrcaCloudAccountAgent,
  setup: OrcaCloudAgentSetup
): ToastView | null {
  const api = globalThis.window?.api?.orcaCloudAgents
  const name = agentName(agent, translate)
  switch (setup.phase) {
    case 'idle':
    case 'saved':
      return null
    case 'browser':
      return {
        message: translate(
          'components.newWorkspace.cloudStart.signInBrowser',
          'Finish signing in to {{agent}} in your browser…',
          { agent: name }
        ),
        // Every phase has a button: an updated toast keeps the last one otherwise.
        action: setup.canReopen
          ? {
              label: translate('orcaCloudAccounts.openAgain', 'Open again'),
              run: () => void api?.reopen({ agent })
            }
          : {
              label: translate('orcaCloudAccounts.cancel', 'Cancel'),
              run: () => void api?.cancel({ agent })
            }
      }
    case 'preparing':
      return {
        message: translate('orcaCloudAccounts.preparing', 'Getting ChatGPT sign-in ready'),
        action: {
          label: translate('orcaCloudAccounts.cancel', 'Cancel'),
          run: () => void api?.cancel({ agent })
        }
      }
    case 'device':
      return {
        message: translate(
          'components.newWorkspace.cloudStart.signInDevice',
          'Enter {{code}} at {{host}} to sign in to {{agent}}.',
          { code: setup.userCode, host: deviceHost(setup.verificationUrl), agent: name }
        ),
        action: {
          label: translate('components.newWorkspace.cloudStart.copyCode', 'Copy code'),
          primary: true,
          run: () => void window.api.ui.writeClipboardText(setup.userCode).catch(() => {})
        }
      }
    case 'paste':
      // The token goes in Settings' masked field, never in a toast.
      return {
        message: translate(
          'components.newWorkspace.cloudStart.signInPaste',
          'Paste the {{agent}} setup token in Settings to finish.',
          { agent: name }
        ),
        action: {
          label: translate('components.newWorkspace.cloudStart.openSettings', 'Open Settings'),
          primary: true,
          run: openOrcaCloudAgentAccounts
        }
      }
    case 'saving':
      return {
        message: translate('components.newWorkspace.cloudStart.signInSaving', 'Saving…')
      }
    case 'failed': {
      const copy = setupFailureCopy(agent, setup.error, translate)
      return {
        message: copy.title,
        ...(copy.detail ? { description: copy.detail } : {}),
        action: {
          label: translate('orcaCloudAccounts.tryAgain', 'Try again'),
          primary: true,
          run: () => void api?.start({ agent })
        }
      }
    }
  }
}
