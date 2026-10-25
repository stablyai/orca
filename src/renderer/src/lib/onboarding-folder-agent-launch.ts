import type { ExecutionHostId } from '../../../shared/execution-host'
import type { OnboardingState } from '../../../shared/onboarding-state-types'
import type { TuiAgent } from '../../../shared/tui-agent'
import type { useAppStore } from '@/store'
import { resolveAgentLaunchExecutionContext } from '@/lib/launch-agent-execution-context'
import {
  planAgentSessionLaunch,
  type AgentSessionLaunchPlan
} from '@/lib/agent-session-launch-plan'
import { newAgentLaunchRequestId } from '@/lib/agent-launch-request-id'
import {
  buildOnboardingFolderAgentStartup,
  onboardingFolderDefaultAgent,
  shouldSeedFolderAgentAfterDismissedOnboarding,
  type OnboardingFolderAgentStartup
} from '@/lib/onboarding-folder-agent-startup'
import { activateAndRevealWorktree } from '@/lib/worktree-activation'
import { beginStructuredAgentSessionProvisionalLaunch } from '@/lib/agent-session/structured-agent-session-provisional-tab'

export type OnboardingFolderAgentLaunch = {
  agent: TuiAgent | null
  /** Null when no default agent applies. */
  plan: AgentSessionLaunchPlan | null
  startup?: OnboardingFolderAgentStartup
}

/** Why: lives beside the launch, not the startup builder, because the store root imports that
 *  builder eagerly and the planner's launch graph reaches back to the store root. */
export function resolveDismissedOnboardingFolderAgentLaunch(args: {
  store: ReturnType<typeof useAppStore.getState>
  onboarding: OnboardingState | null
  hasExistingProject: boolean
  executionHostId: string
  worktreeId: string
}): OnboardingFolderAgentLaunch {
  const agent = onboardingFolderDefaultAgent(args.store.settings)
  if (
    !agent ||
    !shouldSeedFolderAgentAfterDismissedOnboarding(args.onboarding, args.hasExistingProject)
  ) {
    return { agent: null, plan: null }
  }
  // Resolved once per added folder: adding it is the one action this chat serves.
  const plan = planAgentSessionLaunch(args.store, {
    requestId: newAgentLaunchRequestId(),
    agent,
    workspace: {
      kind: 'folder',
      worktreeId: args.worktreeId,
      executionHostId: args.executionHostId
    }
  })
  if (plan.route === 'structured-native-chat') {
    return { agent, plan }
  }
  const context = resolveAgentLaunchExecutionContext(args.store, { worktreeId: args.worktreeId })
  if (!context) {
    return { agent, plan }
  }
  const startup = buildOnboardingFolderAgentStartup(args.store.settings, {
    platform: context.resolvedLaunchPlatform,
    shell: context.queuedShell,
    isRemote: context.isRemote
  })
  return { agent, plan, startup }
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
  const { plan } = args.launch
  const structured = plan?.route === 'structured-native-chat'
  if (!structured) {
    reveal(args.launch.startup)
    return
  }
  beginStructuredAgentSessionProvisionalLaunch({
    plan,
    hooks: {},
    target: { worktreeId: args.worktreeId },
    beforeOpen: () => reveal(undefined, true) !== false
  })
}
