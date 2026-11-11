// After a cloud create whose agent has no Orca Cloud account, the workspace starts with a terminal
// (never the agent's /login). This one toast is the only sign-in prompt (design-squad journey rule;
// PC-1, PC-3).
// - It stays until the user acts on it or dismisses it.
// - It names the workspace once the user has moved to another one.
// - "Set up Claude once" runs the S0 sign-in right from the toast: Claude via setup-token in the
//   browser, Codex via a device code. The toast shows progress and errors, with Try again.
// - It clears itself as soon as the account turns active.
import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store/index'
import { openOrcaCloudAgentAccounts } from '@/components/new-workspace/OrcaCloudAgentSetupRow'
import {
  agentName,
  setupFailureCopy
} from '@/components/settings/agent-accounts/orca-cloud-accounts-copy'
import type {
  OrcaCloudAccountAgent,
  OrcaCloudAgentSetup
} from '../../../../shared/orca-cloud-agents/orca-cloud-agents-wire'
import { orcaCloudAgentCoverageFromAccounts } from './orca-cloud-agent-accounts-model'
import {
  readOrcaCloudAgentAccounts,
  subscribeOrcaCloudAgentAccounts
} from './orca-cloud-agent-accounts-store'

const TOAST_ID = 'orca-cloud-agent-not-started'

let teardown: (() => void) | null = null

export function cloudAgentNotStartedMessage(
  agent: string,
  workspaceName: string | null,
  { starting = false }: { starting?: boolean } = {}
): string {
  // While the sandbox is still starting nothing has failed yet: say it won't start (design-squad).
  if (starting) {
    return workspaceName
      ? translate(
          'components.newWorkspace.cloudStart.agentWillNotStartIn',
          '{{agent}} isn’t set up for Orca Cloud, so it won’t start in {{workspace}}.',
          { agent, workspace: workspaceName }
        )
      : translate(
          'components.newWorkspace.cloudStart.agentWillNotStartShort',
          '{{agent}} isn’t set up for Orca Cloud, so it won’t start.',
          { agent }
        )
  }
  return workspaceName
    ? translate(
        'components.newWorkspace.cloudStart.agentNotStartedIn',
        '{{agent}} isn’t set up for Orca Cloud, so it didn’t start in {{workspace}}.',
        { agent, workspace: workspaceName }
      )
    : translate(
        'components.newWorkspace.cloudStart.agentNotStartedShort',
        '{{agent}} isn’t set up for Orca Cloud, so it didn’t start.',
        { agent }
      )
}

/** True once the agent signs in from the Orca account or a key covers it. */
export function isCloudAgentCovered(agent: OrcaCloudAccountAgent): boolean {
  const coverage = orcaCloudAgentCoverageFromAccounts(agent, readOrcaCloudAgentAccounts())
  return coverage?.kind === 'account' || coverage?.kind === 'key'
}

type ToastView = {
  message: string
  description?: string
  action?: { label: string; run: () => void }
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
          run: () => void api?.start({ agent })
        }
      }
    }
  }
}

export function showCloudAgentNotStartedToast(
  agent: OrcaCloudAccountAgent,
  workspaceName: string,
  {
    onlyWhenAway = false
  }: {
    /**
     * The workspace's agent pane shows its own held strip (PC-3), so the toast appears only while
     * the user is in another workspace, naming this one.
     */
    onlyWhenAway?: boolean
  } = {}
): void {
  teardown?.()
  const name = agentName(agent, translate)
  // The workspace this prompt is about is still being created (its sandbox is starting).
  const isStarting = (state: ReturnType<typeof useAppStore.getState>): boolean =>
    Object.values(state.pendingWorktreeCreations ?? {}).some(
      (creation) => creation.status === 'creating' && creation.request.name === workspaceName
    )
  let switchedAway = false
  const render = (): void => {
    const signIn = cloudAgentSignInView(agent, readOrcaCloudAgentAccounts().setups[agent])
    const view: ToastView = signIn ?? {
      message: cloudAgentNotStartedMessage(
        name,
        switchedAway && workspaceName.trim() ? workspaceName : null,
        { starting: isStarting(useAppStore.getState()) }
      ),
      action: {
        label: translate(
          'components.newWorkspace.cloudStart.setUpAgentOnce',
          'Set up {{agent}} once',
          { agent: name }
        ),
        run: () => void globalThis.window?.api?.orcaCloudAgents?.start({ agent })
      }
    }
    toast.message(view.message, {
      id: TOAST_ID,
      ...(view.description ? { description: view.description } : {}),
      // Persistent (PC-3): it stays until the user acts on it, closes it, or the account is active.
      duration: Number.POSITIVE_INFINITY,
      closeButton: true,
      ...(view.action
        ? {
            action: {
              label: view.action.label,
              onClick: (event: { preventDefault: () => void }) => {
                // Keep the toast: it turns into the sign-in's progress.
                event.preventDefault()
                view.action?.run()
              }
            }
          }
        : {}),
      // A close by the user ends it; a hide on returning to the workspace (onlyWhenAway) doesn't.
      onDismiss: () => {
        if (!onlyWhenAway || switchedAway) {
          teardown?.()
        }
      }
    })
  }
  const update = (): void => {
    if (onlyWhenAway && !switchedAway) {
      toast.dismiss(TOAST_ID)
      return
    }
    render()
  }
  update()

  // The create activates the new workspace (first change); any later change means the user moved.
  let createdOn: string | null | undefined
  let starting = isStarting(useAppStore.getState())
  const stopWorkspace = useAppStore.subscribe((state, previous) => {
    const nowStarting = isStarting(state)
    if (nowStarting !== starting) {
      starting = nowStarting
      update()
    }
    if (state.activeWorktreeId === previous.activeWorktreeId) {
      return
    }
    if (createdOn === undefined) {
      createdOn = state.activeWorktreeId ?? null
      return
    }
    const away = state.activeWorktreeId !== createdOn
    if (away !== switchedAway) {
      switchedAway = away
      update()
    }
  })
  let lastPhase = readOrcaCloudAgentAccounts().setups[agent].phase
  const stopAccounts = subscribeOrcaCloudAgentAccounts(() => {
    if (isCloudAgentCovered(agent)) {
      toast.dismiss(TOAST_ID)
      teardown?.()
      return
    }
    const phase = readOrcaCloudAgentAccounts().setups[agent].phase
    if (phase !== lastPhase) {
      lastPhase = phase
      update()
    }
  })
  teardown = () => {
    stopWorkspace()
    stopAccounts()
    teardown = null
  }
}
