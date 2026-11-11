// After a cloud create whose agent has no Orca Cloud account, the workspace starts with a terminal
// (never the agent's /login). This one toast is the only sign-in prompt (design-squad journey rule;
// PC-1, PC-3).
// - It stays until the user acts on it or dismisses it.
// - It names the workspace once the user has moved to another one.
// - "Set up Claude once" runs the S0 sign-in right from the toast: Claude via setup-token in the
//   browser, Codex via a device code. The toast shows progress and errors, with Try again.
// - It clears itself as soon as the account turns active.
import { hideCloudToast, showCloudToast } from '@/components/orca-cloud/cloud-toast-stack'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store/index'
import { agentName } from '@/components/settings/agent-accounts/orca-cloud-accounts-copy'
import type { OrcaCloudAccountAgent } from '../../../../shared/orca-cloud-agents/orca-cloud-agents-wire'
import { cloudAgentSignInView, type ToastView } from './cloud-agent-sign-in-view'
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

/** A create counts as this toast's when it started at most this long before the toast was asked for. */
const CREATION_MATCH_SLACK_MS = 5_000

export function showCloudAgentNotStartedToast(
  agent: OrcaCloudAccountAgent,
  requestedName: string,
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
  const askedAt = Date.now()
  // The create this prompt is about: the one with the requested name, else the newest create started
  // around this call (the name is often generated later, e.g. an empty name becomes "chinook").
  // Once found it is followed by id, and its real name is the one the toast shows.
  let creationId: string | null = null
  let workspaceName = requestedName.trim()
  const creationFor = (state: ReturnType<typeof useAppStore.getState>) => {
    const creations = Object.values(state.pendingWorktreeCreations ?? {})
    if (creationId) {
      return creations.find((creation) => creation.creationId === creationId)
    }
    const found =
      creations.find((creation) => workspaceName && creation.request.name === workspaceName) ??
      creations
        .filter((creation) => creation.startedAt >= askedAt - CREATION_MATCH_SLACK_MS)
        .sort((a, b) => b.startedAt - a.startedAt)[0]
    if (found) {
      creationId = found.creationId
      workspaceName = found.request.name.trim() || workspaceName
    }
    return found
  }
  // The workspace this prompt is about is still being created (its sandbox is starting).
  const isStarting = (state: ReturnType<typeof useAppStore.getState>): boolean =>
    creationFor(state)?.status === 'creating'
  // DS-p: the prompt is about a workspace that exists. It waits until the sandbox is up (the create
  // moved past provisioning, or finished); a refused create (e.g. the team's running limit) never
  // shows it, only its own error.
  let sandboxUp = false
  let sawCreation = false
  const settle = (state: ReturnType<typeof useAppStore.getState>): 'up' | 'refused' | 'waiting' => {
    const creation = creationFor(state)
    if (creation) {
      sawCreation = true
      if (creation.status === 'error') {
        return 'refused'
      }
      return creation.phase === 'fetching' || creation.phase === 'creating' ? 'up' : 'waiting'
    }
    // Gone from the pending list without an error: the workspace was created.
    return sawCreation ? 'up' : 'waiting'
  }
  let switchedAway = false
  const render = (): void => {
    const signIn = cloudAgentSignInView(agent, readOrcaCloudAgentAccounts().setups[agent])
    const view: ToastView = signIn ?? {
      message: cloudAgentNotStartedMessage(
        name,
        switchedAway && workspaceName ? workspaceName : null,
        { starting: isStarting(useAppStore.getState()) }
      ),
      action: {
        label: translate(
          'components.newWorkspace.cloudStart.setUpAgentOnce',
          'Set up {{agent}} once',
          { agent: name }
        ),
        primary: true,
        run: () => void globalThis.window?.api?.orcaCloudAgents?.start({ agent })
      }
    }
    // The shared cloud toast (DS-q): same chrome as the push notice, and as an action-required
    // prompt it sits on top of the stack. Updating the same id keeps its place and state.
    showCloudToast(
      TOAST_ID,
      {
        priority: 'action',
        lines: [
          {
            key: 'agent',
            text: view.message,
            ...(view.description ? { description: view.description } : {}),
            ...(view.action
              ? {
                  action: {
                    label: view.action.label,
                    primary: view.action.primary === true,
                    // Keeps the toast: it turns into the sign-in's progress.
                    onClick: () => view.action?.run()
                  }
                }
              : {})
          }
        ]
      },
      {
        // Only a close by the user ends it; a hide on returning to the workspace doesn't.
        onDismiss: () => {
          if (!onlyWhenAway || switchedAway) {
            teardown?.()
          }
        }
      }
    )
  }
  const update = (): void => {
    if (!sandboxUp) {
      return
    }
    if (onlyWhenAway && !switchedAway) {
      hideCloudToast(TOAST_ID)
      return
    }
    render()
  }
  const checkCreation = (state: ReturnType<typeof useAppStore.getState>): boolean => {
    if (sandboxUp) {
      return true
    }
    const result = settle(state)
    if (result === 'refused') {
      hideCloudToast(TOAST_ID)
      teardown?.()
      return false
    }
    if (result === 'up') {
      sandboxUp = true
      update()
    }
    return true
  }
  checkCreation(useAppStore.getState())

  // The create activates the new workspace (first change); any later change means the user moved.
  let createdOn: string | null | undefined
  let starting = isStarting(useAppStore.getState())
  const stopWorkspace = useAppStore.subscribe((state, previous) => {
    if (!checkCreation(state)) {
      return
    }
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
      hideCloudToast(TOAST_ID)
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
