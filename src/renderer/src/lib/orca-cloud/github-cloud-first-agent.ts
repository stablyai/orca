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
  const confirmed =
    !worktreeId ||
    host?.kind !== 'runtime' ||
    (await waitForOrcaCloudEnvironment(host.environmentId, deadline))
  if (!worktreeId || !confirmed) {
    agentNotStartedNotice(request.agent, request.fullName, request.hostId)
    return
  }
  const agent = isTuiAgent(request.agent)
    ? request.agent
    : await resolveDefaultAgentForWorktree(useAppStore.getState, worktreeId).catch(() => null)
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
