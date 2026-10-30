import {
  ensureAgentLaunchPreferences,
  type AgentLaunchPreferences
} from '@/components/settings/use-host-agent-launch-preferences'
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

/** Keep planning beside launch: the eagerly imported startup builder cannot reach the launch graph without cycling through store root. */
export async function resolveDismissedOnboardingFolderAgentLaunch(args: {
  store: ReturnType<typeof useAppStore.getState>
  onboarding: OnboardingState | null
  hasExistingProject: boolean
  executionHostId: string
  worktreeId: string
}): Promise<OnboardingFolderAgentLaunch> {
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
  let preferences: AgentLaunchPreferences
  try {
    preferences = await ensureAgentLaunchPreferences(args.store, {
      kind: 'folder',
      worktreeId: args.worktreeId
    })
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      return { agent, plan }
    }
    throw error
  }
  const startup = buildOnboardingFolderAgentStartup(
    args.store.settings
      ? {
          ...args.store.settings,
          agentLaunchChoices:
            preferences.agentLaunchChoices ?? args.store.settings.agentLaunchChoices
        }
      : null,
    {
      platform: context.resolvedLaunchPlatform,
      shell: context.queuedShell,
      isRemote: context.isRemote
    }
  )
  return { agent, plan, startup }
}

/** Share post-onboarding folder reveal/default-agent launch across local and SSH adds; store callers import lazily to avoid the launch/store cycle. */
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
