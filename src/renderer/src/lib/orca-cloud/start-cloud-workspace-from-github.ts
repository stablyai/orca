// "Start in Orca Cloud" for a repository with no clone here (cloud-start D4): the sandbox clones it
// from GitHub, this computer pairs to it like any cloud workspace, and the composer's prompt goes
// to the chosen agent there. Nothing is written to this computer's disk.
import { toast } from 'sonner'
import { useAppStore } from '@/store'
import { translate } from '@/i18n/i18n'
import {
  firstWorktreeOnHost,
  openCloudWorkspace
} from '@/components/cloud-workspaces/open-cloud-workspace'
import { launchAgentInNewTabWithOutcome } from '@/lib/agent-session/launch/new-tab/launch-agent-in-new-tab'
import { createNonSecureContextUuid } from '../../../../shared/non-secure-context-uuid'
import { resolveDefaultAgentForWorktree } from '@/lib/agent-session/launch/shortcuts/agent-tab-shortcuts'
import { captureAgentTabLaunchContext } from '@/components/agent-tab-launch-context'
import { isTuiAgent } from '../../../../shared/agent-launch/catalog/tui-agent-config'
import { parseExecutionHostId } from '../../../../shared/execution-host'
import { isOrcaCloudEnvironmentForLaunch } from './orca-cloud-environment-id'
import { tuiAgentDisplayName } from '../../../../shared/agent-launch/catalog/tui-agent-display-names'

export type StartFromGitHubRequest = {
  repoUrl: string
  fullName: string
  prompt: string
  agent: string | null
}

const failedCopy = (): string =>
  translate(
    'components.newWorkspace.cloudOnly.startFailed',
    'Couldn’t start the cloud workspace. Nothing was created, and you weren’t charged.'
  )

/** Resolves true once the workspace is open (its agent may still be starting). */
export async function startCloudWorkspaceFromGitHub(
  request: StartFromGitHubRequest
): Promise<boolean> {
  const toastId = toast.loading(
    translate('components.newWorkspace.cloudOnly.starting', 'Starting {{repo}} in Orca Cloud…', {
      repo: request.fullName
    })
  )
  // The composer's name field is the workspace's name: send it as the title (NAME-DROPPED).
  const title = request.prompt.trim().slice(0, 120)
  const created = await window.api.orcaCloudWorkspace
    .createFromGitHub({ repoUrl: request.repoUrl, ...(title ? { title } : {}) })
    .catch(() => null)
  if (!created?.ok) {
    toast.error(failedCopy(), { id: toastId })
    return false
  }
  // The sandbox exists from here on: a failure below must never offer to create it again.
  const workspace = await window.api.cloudWorkspaces.get(created.value.sandboxId).catch(() => null)
  const opened = workspace?.ok ? await openCloudWorkspace(workspace.value) : null
  if (!opened?.ok) {
    toast.error(
      translate(
        'components.newWorkspace.cloudOnly.openLater',
        'Your cloud workspace started, but this computer couldn’t open it yet. Open it from Cloud workspaces.'
      ),
      { id: toastId }
    )
    return true
  }
  toast.dismiss(toastId)
  // PAIRED-HELD-STRIPS: the chosen agent starts even with no prompt (its launch is what shows
  // "isn't set up · Set up once" when it can't run yet), and a repo still syncing is waited for
  // rather than dropping the launch.
  if (!request.prompt.trim() && !isTuiAgent(request.agent)) {
    return true
  }
  const deadline = Date.now() + FIRST_WORKTREE_WAIT_MS
  const worktreeId =
    opened.worktreeId ?? (opened.hostId ? await waitForFirstWorktree(opened.hostId) : null)
  // FAIL-CLOSED (#568): the agent goes to a paired host only once it is known as Orca Cloud (so its
  // launch is held when the agent isn't set up), within the same wait; otherwise it isn't started.
  const host = parseExecutionHostId(opened.hostId)
  const confirmed =
    !worktreeId ||
    host?.kind !== 'runtime' ||
    (await waitForOrcaCloudEnvironment(host.environmentId, deadline))
  if (!worktreeId || !confirmed) {
    agentNotStartedNotice(request, opened.hostId)
    return true
  }
  const agent = isTuiAgent(request.agent)
    ? request.agent
    : await resolveDefaultAgentForWorktree(useAppStore.getState, worktreeId).catch(() => null)
  if (agent) {
    launchAgentInNewTabWithOutcome({
      requestId: createNonSecureContextUuid(),
      ...captureAgentTabLaunchContext(worktreeId),
      agent,
      worktreeId,
      ...(request.prompt.trim()
        ? { prompt: request.prompt, promptDelivery: 'submit-after-ready' as const }
        : {}),
      launchSource: 'unknown'
    })
  }
  return true
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

/** How long a freshly paired host may take to list its first worktree (the repo is cloning). */
const FIRST_WORKTREE_WAIT_MS = 90_000

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
 * Never silent: the workspace opened, but its agent couldn't start because no worktree was listed
 * in time. Not over Settings (N-03; with no worktree there is no workspace to scope it to), and gone
 * once the workspace is ready after all.
 */
function agentNotStartedNotice(request: StartFromGitHubRequest, hostId: string | undefined): void {
  console.info(
    `[orca-cloud] ${request.fullName}: no worktree listed in time; the agent was not started`
  )
  if (useAppStore.getState().activeView === 'settings') {
    return
  }
  const toastId = `cloud-agent-not-started:${hostId ?? request.fullName}`
  toast(
    translate(
      'components.newWorkspace.cloudOnly.agentNotStarted',
      '{{agent}} didn’t start because the workspace was still getting ready. Start it from the workspace.',
      {
        agent:
          tuiAgentDisplayName(request.agent ?? '') ??
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

/** How long the "didn't start" notice watches for the workspace becoming ready after all. */
const NOTICE_DISMISS_WAIT_MS = 10 * 60_000
