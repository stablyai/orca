// PAIRED-HELD-STRIPS (#568): the first agent of a GitHub-only Orca Cloud create, once the build sheet
// has handed off to the opened workspace (GH-CREATE-SHEET). The chosen agent starts even with no
// prompt: its launch is what shows "isn't set up · Set up once" when it can't run yet. A repo still
// cloning is waited for, and the host must be confirmed Orca Cloud first (FAIL-CLOSED), so the launch
// always goes through the account hold; a wait that runs out says so instead of launching.
import { toast } from 'sonner'
import { useAppStore } from '@/store'
import { translate } from '@/i18n/i18n'
import { firstWorktreeOnHost } from '@/components/cloud-workspaces/open-cloud-workspace'
import { launchAgentInNewTabWithOutcome } from '@/lib/agent-session/launch/new-tab/launch-agent-in-new-tab'
import { resolveDefaultAgentForWorktree } from '@/lib/agent-session/launch/shortcuts/agent-tab-shortcuts'
import { captureAgentTabLaunchContext } from '@/components/agent-tab-launch-context'
import { createNonSecureContextUuid } from '../../../../shared/non-secure-context-uuid'
import { isTuiAgent } from '../../../../shared/agent-launch/catalog/tui-agent-config'
import { tuiAgentDisplayName } from '../../../../shared/agent-launch/catalog/tui-agent-display-names'
import { parseExecutionHostId } from '../../../../shared/execution-host'
import { isOrcaCloudEnvironmentForLaunch } from './orca-cloud-environment-id'
import { readHeldCloudLaunches } from './cloud-held-launch-memory'
import {
  beginWebRuntimeInitialTerminalBootstrap,
  endWebRuntimeInitialTerminalBootstrap,
  isWebRuntimeInitialTerminalBootstrapInFlight,
  markWebRuntimeInitialTerminalBootstrapAwaitingMirror
} from '@/runtime/web-session-tabs-sync/initial-terminal/web-runtime-initial-terminal-bootstrap'

export type FirstCloudAgentRequest = {
  fullName: string
  prompt: string
  /** The composer's pick; null uses the workspace's default agent (only with a prompt). */
  agent: string | null
  worktreeId: string | null
  hostId?: string
}

/** How long a freshly paired host may take to list its first worktree (the repo is cloning). */
const FIRST_WORKTREE_WAIT_MS = 90_000
/** How long the "didn't start" notice watches for the workspace becoming ready after all. */
const NOTICE_DISMISS_WAIT_MS = 10 * 60_000

export async function launchFirstCloudAgent(request: FirstCloudAgentRequest): Promise<void> {
  const prompt = request.prompt.trim()
  if (!prompt && !isTuiAgent(request.agent)) {
    return
  }
  const deadline = Date.now() + FIRST_WORKTREE_WAIT_MS
  const worktreeId =
    request.worktreeId ?? (request.hostId ? await waitForFirstWorktree(request.hostId) : null)
  const host = parseExecutionHostId(request.hostId)
  const environmentId = host?.kind === 'runtime' ? host.environmentId : null
  // PAIRED-HELD-ACTIVE: the agent's tab (or its held placeholder) is this workspace's first terminal.
  // Without the claim, the mirror's first empty frame seeds a plain shell too, activated, which hides
  // the held placeholder and its "Set up once" strip behind a bare prompt (n39).
  const claimed =
    worktreeId && environmentId
      ? beginWebRuntimeInitialTerminalBootstrap(environmentId, worktreeId)
      : false
  const confirmed =
    !worktreeId || !environmentId || (await waitForOrcaCloudEnvironment(environmentId, deadline))
  if (!worktreeId || !confirmed) {
    if (claimed && worktreeId && environmentId) {
      endWebRuntimeInitialTerminalBootstrap(environmentId, worktreeId)
    }
    agentNotStartedNotice(request.agent, request.fullName, request.hostId)
    return
  }
  const agent = isTuiAgent(request.agent)
    ? request.agent
    : await resolveDefaultAgentForWorktree(useAppStore.getState, worktreeId).catch(() => null)
  if (environmentId) {
    void settleFirstTerminal({ environmentId, worktreeId, claimed, launched: Boolean(agent) })
  }
  if (!agent) {
    return
  }
  launchAgentInNewTabWithOutcome({
    requestId: createNonSecureContextUuid(),
    ...captureAgentTabLaunchContext(worktreeId),
    agent,
    worktreeId,
    ...(prompt ? { prompt: request.prompt, promptDelivery: 'submit-after-ready' as const } : {}),
    launchSource: 'unknown'
  })
}

/** How long the first agent's tab may take to reach this workspace's mirror. */
const FIRST_TAB_WAIT_MS = 30_000

/**
 * The claimed bootstrap latch is released once the workspace has a tab (the seeder then sees it), or
 * handed back to the seeder after the wait so a launch that never arrived still gets its shell. If the
 * seeder had already claimed it, its shell may land on top: once it settles, the held placeholder is
 * brought to the front, once, while the person is still on this workspace.
 */
async function settleFirstTerminal(args: {
  environmentId: string
  worktreeId: string
  claimed: boolean
  launched: boolean
}): Promise<void> {
  const { environmentId, worktreeId } = args
  // Tabs the person could already be on; the seeder's late shell is never one of them.
  const tabsAtLaunch = new Set(
    (useAppStore.getState().tabsByWorktree[worktreeId] ?? []).map((tab) => tab.id)
  )
  if (args.claimed && !args.launched) {
    endWebRuntimeInitialTerminalBootstrap(environmentId, worktreeId)
    return
  }
  const heldTab = (): string | null => {
    const tabs = useAppStore.getState().tabsByWorktree[worktreeId] ?? []
    const record = readHeldCloudLaunches(environmentId).find(
      (each) => each.worktreeId === worktreeId && tabs.some((tab) => tab.id === each.tabId)
    )
    return record?.tabId ?? null
  }
  const hasTab = (): boolean => (useAppStore.getState().tabsByWorktree[worktreeId] ?? []).length > 0
  const ready = await waitForStore(
    () =>
      args.claimed
        ? hasTab()
        : !isWebRuntimeInitialTerminalBootstrapInFlight(environmentId, worktreeId) &&
          heldTab() !== null,
    FIRST_TAB_WAIT_MS
  )
  if (args.claimed) {
    if (ready) {
      endWebRuntimeInitialTerminalBootstrap(environmentId, worktreeId)
    } else {
      markWebRuntimeInitialTerminalBootstrapAwaitingMirror(environmentId, worktreeId)
    }
    return
  }
  const tab = ready ? heldTab() : null
  if (tab && seederShellInFront(worktreeId, tab, tabsAtLaunch)) {
    useAppStore.getState().setActiveTab(tab)
  }
}

/**
 * Never steals focus: only the seeder's late shell (the newest tab, made after the launch began) is
 * replaced in front. Another workspace, or a tab the person was already on, keeps focus.
 */
function seederShellInFront(
  worktreeId: string,
  heldTabId: string,
  tabsAtLaunch: ReadonlySet<string>
): boolean {
  const state = useAppStore.getState()
  const active = state.activeTabId
  const tabs = state.tabsByWorktree[worktreeId] ?? []
  return (
    state.activeWorktreeId === worktreeId &&
    active !== null &&
    active !== heldTabId &&
    !tabsAtLaunch.has(active) &&
    tabs.at(-1)?.id === active
  )
}

function waitForStore(done: () => boolean, waitMs: number): Promise<boolean> {
  if (done()) {
    return Promise.resolve(true)
  }
  return new Promise((resolve) => {
    let recheck: ReturnType<typeof setTimeout> | undefined
    const finish = (value: boolean): void => {
      unsubscribe()
      clearTimeout(recheck)
      clearTimeout(timer)
      resolve(value)
    }
    const check = (): void => {
      if (done()) {
        finish(true)
        return
      }
      // The seeder's latch is not store state: it ends just after the mirror change that came
      // with its shell, so look once more shortly after the last change.
      clearTimeout(recheck)
      recheck = setTimeout(() => done() && finish(true), 300)
    }
    const unsubscribe = useAppStore.subscribe(check)
    const timer = setTimeout(() => finish(done()), waitMs)
  })
}

async function waitForOrcaCloudEnvironment(
  environmentId: string,
  deadline: number
): Promise<boolean> {
  while (!(await isOrcaCloudEnvironmentForLaunch(environmentId))) {
    if (Date.now() >= deadline) {
      return false
    }
    await new Promise((resolve) => setTimeout(resolve, 1000))
  }
  return true
}

function waitForFirstWorktree(
  hostId: string,
  waitMs: number = FIRST_WORKTREE_WAIT_MS
): Promise<string | null> {
  const found = firstWorktreeOnHost(hostId)
  if (found) {
    return Promise.resolve(found)
  }
  return new Promise((resolve) => {
    const finish = (worktreeId: string | null): void => {
      unsubscribe()
      clearTimeout(timer)
      resolve(worktreeId)
    }
    const unsubscribe = useAppStore.subscribe(() => {
      const worktreeId = firstWorktreeOnHost(hostId)
      if (worktreeId) {
        finish(worktreeId)
      }
    })
    const timer = setTimeout(() => finish(null), waitMs)
  })
}

/**
 * Never silent: the workspace opened, but its agent couldn't start in time. Not over Settings (N-03;
 * with no worktree there is no workspace to scope it to), and gone once the workspace is ready.
 */
export function agentNotStartedNotice(
  agent: string | null,
  fullName: string,
  hostId: string | undefined
): void {
  console.info(`[orca-cloud] ${fullName}: no worktree listed in time; the agent was not started`)
  if (useAppStore.getState().activeView === 'settings') {
    return
  }
  const toastId = `cloud-agent-not-started:${hostId ?? fullName}`
  toast(
    translate(
      'components.newWorkspace.cloudOnly.agentNotStarted',
      '{{agent}} didn’t start because the workspace was still getting ready. Start it from the workspace.',
      {
        agent:
          tuiAgentDisplayName(agent ?? '') ??
          translate('components.newWorkspace.cloudOnly.theAgent', 'The agent')
      }
    ),
    { id: toastId }
  )
  if (hostId) {
    void waitForFirstWorktree(hostId, NOTICE_DISMISS_WAIT_MS).then((worktreeId) => {
      if (worktreeId) {
        toast.dismiss(toastId)
      }
    })
  }
}
