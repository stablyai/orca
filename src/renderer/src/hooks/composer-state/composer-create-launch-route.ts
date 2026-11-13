import { resolveAgentSessionLaunchRoute } from '@/lib/agent-session/launch/routing/agent-session-launch-plan'
import type { AgentLaunchChoice } from '@/lib/agent-session/launch/routing/agent-menu-selection'
import type {
  AgentLaunchRouteArgs,
  AgentLaunchRouteStore,
  ProspectiveWorkspace
} from '@/lib/agent-session/launch/routing/agent-launch-route-input'
import type { AgentLaunchRoute } from '@/lib/agent-session/launch/routing/agent-launch-routing'
import { ORCA_CLOUD_PENDING_HOST_CAPABILITIES } from '@/lib/orca-cloud/orca-cloud-pending-host-capabilities'
import { ORCA_CLOUD_RECIPE_ID } from '../../../../shared/hosted-sandbox/orca-cloud-recipe-id'
import type { TuiAgent } from '../../../../shared/agent-launch/catalog/tui-agent'

/** The pending VM's host until the create pairs it. */
const PENDING_VM_HOST_ID = 'runtime:pending-ephemeral-vm'

/**
 * The composer create's chat-or-terminal route, stored on the request and never re-derived.
 * CLOUD-HELD-SURFACE: for a VM create the agent menu has no host to ask (the VM doesn't exist yet),
 * so its choice says "terminal" whatever the person prefers. Unless the person picked a surface, a
 * VM create's route is decided here instead; an Orca Cloud VM's image capabilities stand in for the
 * unverified pending host.
 */
export function composerCreateLaunchRoute(
  store: AgentLaunchRouteStore,
  args: {
    agent: TuiAgent | null
    launchChoice: AgentLaunchChoice | undefined
    /** The VM recipe this create provisions, when it provisions one. */
    vmRecipeId: string | undefined
    workspace: ProspectiveWorkspace
    prompt: string
    promptDelivery: AgentLaunchRouteArgs['promptDelivery']
  }
): AgentLaunchRoute {
  const { agent, launchChoice, vmRecipeId } = args
  if (!agent) {
    return 'terminal-tui'
  }
  const menuDecides = vmRecipeId === undefined || launchChoice?.requestedSurface !== undefined
  if (menuDecides && launchChoice) {
    return launchChoice.route
  }
  return resolveAgentSessionLaunchRoute(
    store,
    {
      agent,
      workspace: {
        ...args.workspace,
        ...(vmRecipeId !== undefined ? { executionHostId: PENDING_VM_HOST_ID } : {})
      },
      prompt: args.prompt,
      promptDelivery: args.promptDelivery,
      ...(vmRecipeId === ORCA_CLOUD_RECIPE_ID
        ? { pendingHostCapabilities: ORCA_CLOUD_PENDING_HOST_CAPABILITIES }
        : {})
    },
    { reportDowngrade: true }
  )
}
