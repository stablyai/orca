// Private layer, Orca Cloud only (RA-1, PC-3b). An Orca Cloud workspace is a paired web host, so
// every Claude/Codex launch the desktop asks it for becomes one host terminal create. This is the
// single hold for all of them: a new tab, a create's first agent, an agent restarted after a wake.
// When the agent's Orca account is expired (or not set up) and no key covers it, the host opens a
// plain shell tab instead; its pane shows the strip, and the agent starts in its place (with the
// launch's own prompt) once Renew or the one-time setup is done and the person starts it. Cancel
// leaves the plain shell.
import { toast } from 'sonner'
import { toWebTerminalSurfaceTabId } from '../../../../shared/workspace-layout/terminal-surface-id'
import { webTerminalPlacementParentTabId } from '@/runtime/hosted-terminals/placement/web-session-terminal-placement'
import { closeWebRuntimeSessionTab } from '@/runtime/web-session-tabs-sync/actions/web-runtime-session-tab-lifecycle'
import type {
  CreateWebRuntimeSessionTerminalOnHostArgs,
  CreatedWebRuntimeSessionTerminal
} from '@/runtime/hosted-terminals/creation/terminal-create-contracts'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import { isOrcaCloudEnvironmentId } from './orca-cloud-environment-id'
import {
  cloudAgentLaunchDecision,
  cloudTabHoldKey,
  holdCloudAgentLaunch,
  takeCloudAgentHoldStartedByPerson
} from './cloud-agent-launch-hold'

type CreateHostTerminal = (
  args: CreateWebRuntimeSessionTerminalOnHostArgs
) => Promise<CreatedWebRuntimeSessionTerminal>

/** A fresh Claude/Codex launch on an Orca Cloud host: the only creates the account hold applies to. */
function heldAgent(args: CreateWebRuntimeSessionTerminalOnHostArgs): 'claude' | 'codex' | null {
  const agent = args.launchAgent ?? args.agent
  if (agent !== 'claude' && agent !== 'codex') {
    return null
  }
  // A resume continues a conversation the account already started; #315/RA-11 own that path.
  if (args.agentSessionKind === 'resume' || args.providerSession) {
    return null
  }
  return args.environmentId && isOrcaCloudEnvironmentId(args.environmentId) ? agent : null
}

/** The plain shell a held launch waits in: the same place, no agent, no startup. */
function placeholderArgs(
  args: CreateWebRuntimeSessionTerminalOnHostArgs
): CreateWebRuntimeSessionTerminalOnHostArgs {
  return {
    worktreeId: args.worktreeId,
    environmentId: args.environmentId,
    ...(args.targetGroupId ? { targetGroupId: args.targetGroupId } : {}),
    ...(args.afterTabId ? { afterTabId: args.afterTabId } : {}),
    ...(args.cwd?.trim() ? { cwd: args.cwd } : {}),
    ...(args.activate === false ? { activate: false } : {}),
    ...(args.selectWorktree === false ? { selectWorktree: false } : {})
  }
}

/**
 * Creates the host terminal at once unless it launches Claude/Codex on Orca Cloud and the account
 * hold applies; then it holds in a plain shell first. Never throws past `create`; a failed
 * placeholder creates the terminal as before rather than block on a broken host.
 */
export async function createWithCloudAgentHold(
  args: CreateWebRuntimeSessionTerminalOnHostArgs,
  create: CreateHostTerminal
): Promise<CreatedWebRuntimeSessionTerminal> {
  const agent = heldAgent(args)
  if (!agent || (await cloudAgentLaunchDecision(agent)) !== 'hold') {
    return await create(args)
  }
  const placeholder = await create(placeholderArgs(args)).catch(() => null)
  if (placeholder?.outcome.status !== 'created' || !placeholder.hostTabId) {
    return await create(args)
  }
  const tabId = toWebTerminalSurfaceTabId(webTerminalPlacementParentTabId(placeholder.hostTabId))
  const outcome = await holdCloudAgentLaunch({
    paneKey: cloudTabHoldKey(tabId),
    agent,
    prompt: args.prompt?.trim() || null,
    decided: true
  })
  if (outcome === 'cancel') {
    // NOACCT-MISLABEL: the confirmation answers the person's own Cancel, while the shell is still
    // there. A hold that ended because its tab or workspace went away (deleted, archived, closed)
    // says nothing: there is no shell left, and nothing failed to start.
    if (isTabOpen(args.worktreeId, tabId)) {
      toast(
        translate(
          'agentSignInStrip.cancelledToast',
          'The agent didn’t start. The shell is still open.'
        )
      )
    }
    return placeholder
  }
  // Started by the person's click in the held pane: bring the agent's tab forward so they see their
  // queued prompt run. A Renew's auto-start (maybe on a background tab) never steals focus.
  const startedByPerson = takeCloudAgentHoldStartedByPerson(cloudTabHoldKey(tabId))
  const created = await create(startedByPerson ? { ...args, activate: true } : args)
  // The agent opened in its own tab; the placeholder shell has done its job.
  if (args.environmentId) {
    const closed = closeWebRuntimeSessionTab({
      worktreeId: args.worktreeId,
      tabId,
      environmentId: args.environmentId,
      reason: 'user'
    }).catch(() => undefined)
    if (startedByPerson && created.hostTabId) {
      // Closing the (active) placeholder selects its neighbour, a plain terminal; the person asked
      // for the agent, so its tab takes focus once the placeholder is gone.
      const agentTabId = toWebTerminalSurfaceTabId(
        webTerminalPlacementParentTabId(created.hostTabId)
      )
      void closed.then(() => focusAgentTab(args.worktreeId, agentTabId))
    }
  }
  return created
}

/** The held placeholder's tab is still in its workspace (not closed, deleted or archived away). */
export function isTabOpen(worktreeId: string, tabId: string): boolean {
  return (useAppStore.getState().tabsByWorktree[worktreeId] ?? []).some((tab) => tab.id === tabId)
}

// The agent's tab can reach the store after the placeholder's close (a create's sync is slower).
const AGENT_TAB_FOCUS_WAIT_MS = 10_000

/** Focus the agent's tab once it is in the store, unless the person picked another tab meanwhile. */
function focusAgentTab(worktreeId: string, agentTabId: string): void {
  const hasTab = (): boolean =>
    (useAppStore.getState().tabsByWorktree[worktreeId] ?? []).some((tab) => tab.id === agentTabId)
  if (hasTab()) {
    useAppStore.getState().setActiveTab(agentTabId)
    return
  }
  const activeAtClose = useAppStore.getState().activeTabId
  let done = false
  const finish = (): void => {
    done = true
    unsubscribe()
    clearTimeout(timer)
  }
  const unsubscribe = useAppStore.subscribe((state) => {
    if (done) {
      return
    }
    if (state.activeTabId !== activeAtClose && state.activeTabId !== agentTabId) {
      // The person chose a tab themselves: never take it from them.
      finish()
      return
    }
    if (hasTab()) {
      finish()
      useAppStore.getState().setActiveTab(agentTabId)
    }
  })
  const timer = setTimeout(() => {
    if (!done) {
      finish()
    }
  }, AGENT_TAB_FOCUS_WAIT_MS)
}
