// "Start in Orca Cloud" for a repository with no clone here (cloud-start D4): the sandbox clones it
// from GitHub, this computer pairs to it like any cloud workspace, and the composer's prompt goes
// to the chosen agent there. Nothing is written to this computer's disk.
import { toast } from 'sonner'
import { useAppStore } from '@/store'
import { translate } from '@/i18n/i18n'
import { openCloudWorkspace } from '@/components/cloud-workspaces/open-cloud-workspace'
import { launchAgentInNewTabWithOutcome } from '@/lib/agent-session/launch/new-tab/launch-agent-in-new-tab'
import { createNonSecureContextUuid } from '../../../../shared/non-secure-context-uuid'
import { resolveDefaultAgentForWorktree } from '@/lib/agent-session/launch/shortcuts/agent-tab-shortcuts'
import { captureAgentTabLaunchContext } from '@/components/agent-tab-launch-context'
import { isTuiAgent } from '../../../../shared/agent-launch/catalog/tui-agent-config'

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
  const created = await window.api.orcaCloudWorkspace
    .createFromGitHub({ repoUrl: request.repoUrl })
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
  const worktreeId = opened.worktreeId
  if (!worktreeId || !request.prompt.trim()) {
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
      prompt: request.prompt,
      promptDelivery: 'submit-after-ready',
      launchSource: 'unknown'
    })
  }
  return true
}
