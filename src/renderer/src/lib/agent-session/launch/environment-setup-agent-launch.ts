import { toast } from 'sonner'
import { useAppStore } from '@/store/index'
import { translate } from '@/i18n/i18n'
import { resolveDefaultAgentForWorktree } from '@/lib/agent-session/launch/shortcuts/agent-tab-shortcuts'
import { launchAgentInNewTabWithOutcome } from '@/lib/agent-session/launch/new-tab/launch-agent-in-new-tab'
import { newAgentLaunchRequestId } from '@/lib/agent-session/launch/routing/agent-launch-request-id'
import { captureAgentTabLaunchContext } from '@/components/agent-tab-launch-context'
import { activateAndRevealWorktreeWithOutcome } from '@/lib/workspace/activation/worktree-activation'
import { reportAgentWorkspaceActivation } from '@/lib/workspace/activation/worktree-activation-outcome'
import { focusTerminalTabSurface } from '@/components/terminal-pane/input/focus/focus-terminal-tab-surface'
import { isGitRepoKind } from '../../../../../shared/repo-kind'
import type { Repo } from '../../../../../shared/repo-types'
import type { Worktree } from '../../../../../shared/worktree/types'
import {
  buildEnvironmentSetupAgentPrompt,
  type EnvironmentSetupFailureContext
} from '../../../../../shared/environment-setup-agent-prompt'

/** The Git project an environment-setup agent should work on: the active one, else the first. */
export function pickEnvironmentSetupRepo(
  repos: readonly Repo[],
  activeRepoId: string | null
): Repo | null {
  const gitRepos = repos.filter((repo) => isGitRepoKind(repo))
  return gitRepos.find((repo) => repo.id === activeRepoId) ?? gitRepos[0] ?? null
}

/** The repo's workspace the agent should edit: the active one, else the primary checkout. */
function pickEnvironmentSetupWorktree(repoId: string): Worktree | null {
  const state = useAppStore.getState()
  const candidates = state
    .allWorktrees()
    .filter((entry) => entry.repoId === repoId && !entry.isArchived)
  return (
    candidates.find((entry) => entry.id === state.activeWorktreeId) ??
    candidates.find((entry) => entry.isMainWorktree) ??
    candidates[0] ??
    null
  )
}

/** Start the default agent in a new tab with the per-workspace environment skill and doctor loop. */
export async function launchEnvironmentSetupAgent(args: {
  repoId: string
  recipeId?: string
  failure?: EnvironmentSetupFailureContext
}): Promise<boolean> {
  let worktree = pickEnvironmentSetupWorktree(args.repoId)
  if (!worktree) {
    // The sidebar loads worktrees lazily; a project never expanded this session has none yet.
    await useAppStore
      .getState()
      .fetchWorktrees(args.repoId)
      .catch(() => false)
    worktree = pickEnvironmentSetupWorktree(args.repoId)
  }
  if (!worktree) {
    toast.error(
      translate(
        'auto.lib.environmentSetupAgentLaunch.noWorkspace',
        'Open a workspace for this project first, then try again.'
      )
    )
    return false
  }
  const worktreeId = worktree.id
  const agent = await resolveDefaultAgentForWorktree(useAppStore.getState, worktreeId).catch(
    () => null
  )
  if (!agent) {
    toast.error(
      translate(
        'auto.lib.environmentSetupAgentLaunch.noAgent',
        'No enabled AI agent was detected for this workspace.'
      )
    )
    return false
  }
  const outcome = launchAgentInNewTabWithOutcome({
    requestId: newAgentLaunchRequestId(),
    ...captureAgentTabLaunchContext(worktreeId),
    agent,
    worktreeId,
    prompt: buildEnvironmentSetupAgentPrompt({
      ...(args.recipeId ? { recipeId: args.recipeId } : {}),
      ...(args.failure ? { failure: args.failure } : {})
    }),
    promptDelivery: 'submit-after-ready',
    launchSource: 'unknown',
    beforeSurfaceOpen: () =>
      reportAgentWorkspaceActivation(
        activateAndRevealWorktreeWithOutcome(worktreeId, {
          agent,
          providesInitialSurface: true,
          sidebarRevealBehavior: 'auto'
        }),
        agent
      )
  })
  if (!outcome || 'refused' in outcome) {
    return false
  }
  if (outcome.surface.kind === 'local-terminal') {
    focusTerminalTabSurface(outcome.surface.tabId)
  }
  return true
}
