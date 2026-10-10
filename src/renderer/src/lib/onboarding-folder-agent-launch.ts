import { LOCAL_EXECUTION_HOST_ID, type ExecutionHostId } from '../../../shared/execution-host'
import type { OnboardingState } from '../../../shared/onboarding-state-types'
import type { TuiAgent } from '../../../shared/tui-agent'
import type { AgentLaunchRouteStore } from '@/lib/agent-launch-route-input'
import {
  planAgentSessionLaunch,
  type AgentSessionLaunchPlan
} from '@/lib/agent-session-launch-plan'
import { newAgentLaunchRequestId } from '@/lib/agent-launch-request-id'
import {
  buildDismissedOnboardingFolderAgentStartup,
  type OnboardingFolderAgentStartup
} from '@/lib/onboarding-folder-agent-startup'
import { activateAndRevealWorktree } from '@/lib/worktree-activation'
import { beginStructuredAgentSessionProvisionalLaunch } from '@/lib/structured-agent-session-provisional-tab'
import {
  freshNewTabLaunchesThroughHost,
  launchFreshNewTabThroughHost
} from '@/lib/launch-agent-new-tab-host-route'
import { getKnownExecutionHostIdForWorktree } from '@/lib/worktree-runtime-owner'
import { CLIENT_PLATFORM } from '@/lib/new-workspace'
import { resolveAgentLaunchExecutionContext } from '@/lib/launch-agent-execution-context'
import { resolveStartupShell } from '../../../shared/tui-agent-startup-shell'
import { useAppStore } from '@/store'

export type OnboardingFolderAgentLaunch = {
  agent: TuiAgent | null
  /** Planned before the folder workspace row exists; null when no default agent applies. */
  plan: AgentSessionLaunchPlan | null
  startup?: OnboardingFolderAgentStartup
}

/** Why: lives beside the launch, not the startup builder, because the store root imports that
 *  builder eagerly and the planner's launch graph reaches back to the store root. */
export function resolveDismissedOnboardingFolderAgentLaunch(args: {
  store: AgentLaunchRouteStore
  onboarding: OnboardingState | null
  hasExistingProject: boolean
  executionHostId: string
}): OnboardingFolderAgentLaunch {
  const startup = buildDismissedOnboardingFolderAgentStartup(
    args.store.settings ?? null,
    args.onboarding,
    args.hasExistingProject
  )
  const agent = startup?.launchAgent ?? null
  if (!startup || !agent) {
    return { agent: null, plan: null }
  }
  // Resolved once per added folder: adding it is the one action this chat serves.
  const plan = planAgentSessionLaunch(args.store, {
    requestId: newAgentLaunchRequestId(),
    agent,
    workspace: { kind: 'folder', executionHostId: args.executionHostId }
  })
  return {
    agent,
    plan,
    ...(plan.route === 'structured-native-chat' ? {} : { startup })
  }
}

/** Whether the folder's agent starts through this computer's host, as a plain new tab's does: only
 *  on this computer, and only where the host quotes it as main's window does (this computer's
 *  platform and its default shell). Temporary: the rest keeps main's window launch. */
function onboardingFolderLaunchesThroughHost(worktreeId: string, agent: TuiAgent): boolean {
  const state = useAppStore.getState()
  const { resolvedLaunchPlatform, queuedShell } = resolveAgentLaunchExecutionContext(state, {
    worktreeId
  })
  return (
    getKnownExecutionHostIdForWorktree(state, worktreeId) === LOCAL_EXECUTION_HOST_ID &&
    resolveStartupShell(resolvedLaunchPlatform, queuedShell) ===
      resolveStartupShell(CLIENT_PLATFORM) &&
    freshNewTabLaunchesThroughHost({ freshNewTab: true, worktreeId, agent }, resolvedLaunchPlatform)
  )
}

/** Reveal a folder just added after dismissed onboarding and start its default agent on the
 *  planned route. Both add-folder paths (local store action, SSH dialog) share this; the store
 *  path must import it lazily because the launch graph reaches the store root. */
export async function revealOnboardingFolderWithAgentLaunch(args: {
  worktreeId: string
  executionHostId: ExecutionHostId | undefined
  launch: OnboardingFolderAgentLaunch
}): Promise<void> {
  const reveal = (
    startup: OnboardingFolderAgentStartup | undefined,
    providesInitialSurface = false
  ) =>
    activateAndRevealWorktree(args.worktreeId, {
      sidebarRevealBehavior: 'auto',
      ...(args.executionHostId ? { executionHostId: args.executionHostId } : {}),
      ...(startup ? { startup } : {}),
      ...(providesInitialSurface ? { providesInitialSurface: true } : {})
    })
  const { agent, plan, startup } = args.launch
  const structured = plan?.route === 'structured-native-chat'
  if (!structured) {
    if (agent && startup && onboardingFolderLaunchesThroughHost(args.worktreeId, agent)) {
      // The host's agent tab is the folder's first tab, so activation seeds no shell beside it.
      if (reveal(undefined, true) !== false) {
        launchFreshNewTabThroughHost({
          agent,
          worktreeId: args.worktreeId,
          prompt: '',
          launchSource: 'onboarding',
          pendingActivationSpawn: true
        })
      }
      return
    }
    reveal(startup)
    return
  }
  beginStructuredAgentSessionProvisionalLaunch({
    plan,
    hooks: {},
    target: { worktreeId: args.worktreeId },
    beforeOpen: () => reveal(undefined, true) !== false
  })
}
