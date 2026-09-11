import type { ExecutionHostId } from '../../../shared/execution-host'
import type { OnboardingState } from '../../../shared/onboarding-state-types'
import type { TuiAgent } from '../../../shared/tui-agent'
import type { AgentLaunchRouteStore } from '@/lib/agent-launch-route-input'
import {
  planAgentSessionLaunch,
  type AgentSessionLaunchPlan
} from '@/lib/agent-session-launch-plan'
import {
  buildDismissedOnboardingFolderAgentStartup,
  type OnboardingFolderAgentStartup
} from '@/lib/onboarding-folder-agent-startup'
import { activateAndRevealWorktree } from '@/lib/worktree-activation'

export type OnboardingFolderAgentLaunch = {
  agent: TuiAgent | null
  /** Planned before the folder workspace row exists; null when no default agent applies. */
  plan: AgentSessionLaunchPlan | null
  startup?: OnboardingFolderAgentStartup
  fallbackStartup?: OnboardingFolderAgentStartup
}

/** Why: lives beside the launch, not the startup builder, because the store root imports that
 *  builder eagerly and the planner's launch graph reaches back to the store root. */
export function resolveDismissedOnboardingFolderAgentLaunch(args: {
  store: AgentLaunchRouteStore
  onboarding: OnboardingState | null
  hasExistingProject: boolean
  executionHostId: string
  nativeChatTranscriptIsLocalReadable?: boolean
}): OnboardingFolderAgentLaunch {
  const startup = buildDismissedOnboardingFolderAgentStartup(
    args.store.settings ?? null,
    args.onboarding,
    args.hasExistingProject,
    args.nativeChatTranscriptIsLocalReadable
  )
  const agent = startup?.launchAgent ?? null
  if (!startup || !agent) {
    return { agent: null, plan: null }
  }
  const plan = planAgentSessionLaunch(args.store, {
    agent,
    workspace: { kind: 'folder', executionHostId: args.executionHostId },
    initialSessionOptions: startup.sessionOptions
  })
  return {
    agent,
    plan,
    ...(plan.route === 'structured-native-chat' ? { fallbackStartup: startup } : { startup })
  }
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
  reveal(args.launch.startup, structured)
  if (!structured) {
    return
  }
  // Why: the outcome is not consumed; the workspace is already revealed and the launch layer toasts.
  await plan.launch(
    {
      legacyFallback: async () => {
        const activation = reveal(args.launch.fallbackStartup)
        return { activation, primaryTabId: activation === false ? null : activation.primaryTabId }
      }
    },
    { worktreeId: args.worktreeId }
  )
}
