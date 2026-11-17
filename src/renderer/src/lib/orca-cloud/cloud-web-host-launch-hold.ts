// Private layer, Orca Cloud only. An Orca Cloud workspace is a paired web host, so
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
import { isOrcaCloudEnvironmentForLaunch } from './orca-cloud-environment-id'
import {
  cloudAgentLaunchDecision,
  cloudTabHoldKey,
  holdCloudAgentLaunch,
  takeCloudAgentHoldStartedByPerson
} from './cloud-agent-launch-hold'
import {
  forgetHeldCloudLaunch,
  heldLaunchOptions,
  rememberHeldCloudLaunch
} from './cloud-held-launch-memory'

export type CreateHostTerminal = (
  args: CreateWebRuntimeSessionTerminalOnHostArgs
) => Promise<CreatedWebRuntimeSessionTerminal>

/** A fresh Claude/Codex launch on an Orca Cloud host: the only creates the account hold applies to. */
async function heldAgent(
  args: CreateWebRuntimeSessionTerminalOnHostArgs
): Promise<'claude' | 'codex' | null> {
  const agent = args.launchAgent ?? args.agent
  if (agent !== 'claude' && agent !== 'codex') {
    return null
  }
  // A resume continues a conversation the account already started; the account restart path owns it.
  if (args.agentSessionKind === 'resume' || args.providerSession) {
    return null
  }
  // Asks main when the catalog flag isn't here yet (a fresh pairing).
  return args.environmentId && (await isOrcaCloudEnvironmentForLaunch(args.environmentId))
    ? agent
    : null
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
 * hold applies; then it holds in a plain shell first. Never throws past `create`. Fails
 * closed: when the placeholder can't be created, the agent is not launched unheld either; the
 * failed create is returned as is.
 */
export async function createWithCloudAgentHold(
  args: CreateWebRuntimeSessionTerminalOnHostArgs,
  create: CreateHostTerminal
): Promise<CreatedWebRuntimeSessionTerminal> {
  const agent = await heldAgent(args)
  if (!agent || (await cloudAgentLaunchDecision(agent)) !== 'hold') {
    return await create(args)
  }
  const placeholder = await create(placeholderArgs(args))
  if (placeholder.outcome.status !== 'created' || !placeholder.hostTabId) {
    return placeholder
  }
  const tabId = toWebTerminalSurfaceTabId(webTerminalPlacementParentTabId(placeholder.hostTabId))
  // The hold is in memory; this record lets a restart put it back in the same placeholder.
  if (args.environmentId) {
    rememberHeldCloudLaunch({
      environmentId: args.environmentId,
      worktreeId: args.worktreeId,
      tabId,
      agent,
      prompt: args.prompt?.trim() || null,
      cwd: args.cwd?.trim() || null,
      targetGroupId: args.targetGroupId ?? null,
      options: heldLaunchOptions(args),
      createdAt: Date.now()
    })
  }
  return (await settleHeldPlaceholder({ args, tabId, agent, create, decided: true })) ?? placeholder
}

/**
 * Holds a launch in its placeholder tab until the strip releases it, then starts the agent in its
 * own tab and closes the placeholder. Cancel leaves the shell (returns null). An agent create that
 * fails (the VM went to sleep meanwhile, the host timed out) keeps the placeholder, its record and
 * the prompt, and holds again so Start can retry. The record is forgotten only once the agent
 * started or the hold was cancelled.
 */
export async function settleHeldPlaceholder({
  args,
  tabId,
  agent,
  create,
  decided = false,
  restored = false
}: {
  args: CreateWebRuntimeSessionTerminalOnHostArgs
  tabId: string
  agent: 'claude' | 'codex'
  create: CreateHostTerminal
  decided?: boolean
  restored?: boolean
}): Promise<CreatedWebRuntimeSessionTerminal | null> {
  const paneKey = cloudTabHoldKey(tabId)
  const prompt = args.prompt?.trim() || null
  let holdDecided = decided
  let holdRestored = restored
  for (let attempt = 0; ; attempt++) {
    const created = await releaseHeldPlaceholderOnce({
      args,
      tabId,
      agent,
      create,
      paneKey,
      prompt,
      decided: holdDecided,
      restored: holdRestored,
      retrying: attempt > 0
    })
    if (created !== 'retry') {
      return created
    }
    // Held again in the same shell, as a launch waiting for Start (the account itself is fine).
    holdDecided = true
    holdRestored = true
  }
}

async function releaseHeldPlaceholderOnce({
  args,
  tabId,
  agent,
  create,
  paneKey,
  prompt,
  decided,
  restored,
  retrying
}: {
  args: CreateWebRuntimeSessionTerminalOnHostArgs
  tabId: string
  agent: 'claude' | 'codex'
  create: CreateHostTerminal
  paneKey: string
  prompt: string | null
  decided: boolean
  restored: boolean
  retrying: boolean
}): Promise<CreatedWebRuntimeSessionTerminal | null | 'retry'> {
  let outcome: 'proceed' | 'cancel'
  try {
    outcome = await holdCloudAgentLaunch({ paneKey, agent, prompt, decided, restored })
    // The agent's create below goes through the account hold too, so a launch
    // released while its account still can't run it (a restored 'unread' hold on an account that
    // isn't set up) would hold again in a SECOND placeholder. Hold again in this one instead, on the
    // same read that decided it (decided: the hold takes the cached reason, so this can't spin).
    while (outcome === 'proceed' && (await cloudAgentLaunchDecision(agent)) === 'hold') {
      takeCloudAgentHoldStartedByPerson(paneKey)
      outcome = await holdCloudAgentLaunch({ paneKey, agent, prompt, decided: true, restored })
    }
  } catch (error) {
    forgetHeldCloudLaunch(tabId)
    throw error
  }
  if (outcome === 'cancel') {
    forgetHeldCloudLaunch(tabId)
    // The confirmation answers the person's own Cancel, while the shell is still
    // there. A hold that ended because its tab or workspace went away (deleted, archived, closed)
    // says nothing: there is no shell left, and nothing failed to start.
    // Defense in depth: only over its own workspace, never over another one or Settings.
    if (isTabOpen(args.worktreeId, tabId) && workspaceOnScreen(args.worktreeId)) {
      toast(
        translate(
          'agentSignInStrip.cancelledToast',
          'The agent didn’t start. The shell is still open.'
        )
      )
    }
    return null
  }
  // Started by the person's click in the held pane: bring the agent's tab forward so they see their
  // queued prompt run. A Renew's auto-start (maybe on a background tab) never steals focus.
  const startedByPerson = takeCloudAgentHoldStartedByPerson(cloudTabHoldKey(tabId))
  if (retrying && !startedByPerson) {
    // An automatic release right after a failed start (e.g. covered in this workspace) would retry in
    // a tight loop while the host is still down: space those retries out. Start always runs at once.
    await new Promise((resolve) => setTimeout(resolve, HELD_START_RETRY_MS))
  }
  const created = await create(startedByPerson ? { ...args, activate: true } : args)
  if (created.outcome.status !== 'created') {
    // No agent tab: keep the shell, its record and the prompt, and hold again so Start can retry
    // (a tab or workspace that went away meanwhile ends that hold as a cancel).
    console.info(`[orca-cloud] held launch did not start; holding again in ${tabId}`)
    if (isTabOpen(args.worktreeId, tabId)) {
      return 'retry'
    }
    forgetHeldCloudLaunch(tabId)
    return created
  }
  forgetHeldCloudLaunch(tabId)
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

/** Spacing of automatic retries after a held agent failed to start. */
const HELD_START_RETRY_MS = 10_000

/** The held placeholder's tab is still in its workspace (not closed, deleted or archived away). */
export function isTabOpen(worktreeId: string, tabId: string): boolean {
  return (useAppStore.getState().tabsByWorktree[worktreeId] ?? []).some((tab) => tab.id === tabId)
}

/** The workspace is the one in front, in the workspace view (not Settings or another page). */
function workspaceOnScreen(worktreeId: string): boolean {
  const state = useAppStore.getState()
  return state.activeView === 'terminal' && state.activeWorktreeId === worktreeId
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
