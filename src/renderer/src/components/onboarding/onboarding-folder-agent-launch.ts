import { toast } from 'sonner'
import { ensureAgentLaunchPreferences } from '@/runtime/agent-launch-settings/use-host-agent-launch-preferences'
import type { AgentLaunchPreferences } from '@/runtime/agent-launch-settings/host-agent-launch-preferences-resource'
import type { ExecutionHostId } from '../../../../shared/execution-host'
import type { OnboardingState } from '../../../../shared/onboarding-state-types'
import type { TuiAgent } from '../../../../shared/agent-launch/catalog/tui-agent'
import type { useAppStore } from '@/store/index'
import {
  notifyAgentLaunchFailure,
  agentLaunchRecoveryMessage
} from '../../lib/agent-session/launch/failure/agent-launch-failure'
import { resolveAgentLaunchExecutionContext } from '@/lib/agent-session/launch/new-tab/launch-agent-execution-context'
import {
  planAgentSessionLaunch,
  type AgentSessionLaunchPlan
} from '@/lib/agent-session/launch/routing/agent-session-launch-plan'

import { createNonSecureContextUuid } from '../../../../shared/non-secure-context-uuid'
import {
  buildOnboardingFolderAgentStartup,
  onboardingFolderDefaultAgent,
  shouldSeedFolderAgentAfterDismissedOnboarding,
  type OnboardingFolderAgentStartup
} from '@/components/onboarding/onboarding-folder-agent-startup'
import { activateAndRevealWorktree } from '@/lib/workspace/activation/worktree-activation'
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
    requestId: createNonSecureContextUuid(),
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
  if ('unavailable' in context) {
    // A host still connecting is a wait, not a failure, so it gets no message.
    if (!context.unavailable.pending) {
      notifyAgentLaunchFailure(agent, agentLaunchRecoveryMessage(context.unavailable.recovery))
    }
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
    if (args.launch.startup?.warning) {
      toast.info(args.launch.startup.warning)
    }
    return
  }
  beginStructuredAgentSessionProvisionalLaunch({
    plan,
    hooks: {},
    target: { worktreeId: args.worktreeId },
    beforeOpen: () => reveal(undefined, true) !== false
  })
}
