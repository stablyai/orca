import type { Automation, AutomationUpdateInput } from '../../../../shared/automations-types'
import { hasExtraAgentArgs } from '../../../../shared/automation-extra-agent-args'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import {
  AUTOMATION_SURFACE_RUNTIME_CAPABILITY,
  STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY,
  STRUCTURED_AGENT_SESSION_CLIENT_LAUNCH_MODE_CAPABILITY,
  STRUCTURED_AGENT_SESSION_REGISTERED_AGENTS_RUNTIME_CAPABILITY
} from '../../../../shared/protocol-version'
import { nativeChatPreferenceFor } from '../../../../shared/structured-native-chat-launch-route'
import {
  buildAgentLaunchRouteInput,
  type AgentLaunchRouteStore,
  type ProspectiveWorkspace
} from '@/lib/agent-launch-route-input'
import { structuredAgentLaunchSupport } from '@/lib/agent-launch-routing'
import type { AutomationDraft } from './AutomationEditorDialog'
import type { AutomationCreateDestinationResolution } from './automation-create-destination'

export function automationLaunchWorkspace(
  draft: AutomationDraft,
  destination?: AutomationCreateDestinationResolution
): ProspectiveWorkspace {
  const ready = destination?.status === 'ready' ? destination : null
  return {
    kind: 'git-worktree',
    repoId: draft.projectId,
    ...(draft.workspaceMode === 'existing' && draft.workspaceId
      ? { worktreeId: draft.workspaceId }
      : {}),
    ...(ready
      ? {
          executionHostId:
            ready.destination.selector.kind === 'ssh'
              ? `ssh:${ready.destination.selector.targetId}`
              : ready.authority.kind === 'runtime'
                ? `runtime:${ready.authority.environmentId}`
                : 'local'
        }
      : {})
  }
}

export function automationChatSupport(
  state: AgentLaunchRouteStore,
  draft: AutomationDraft,
  workspace: ProspectiveWorkspace
): boolean | null {
  const input = buildAgentLaunchRouteInput(state, { agent: draft.agentId, workspace })
  if (
    input.hostCapabilities !== null &&
    !input.hostCapabilities.includes(AUTOMATION_SURFACE_RUNTIME_CAPABILITY)
  ) {
    return false
  }
  // Satisfy only unlearned facts to expose independent blockers, never to establish support.
  const possible = structuredAgentLaunchSupport({
    ...input,
    hostCapabilities: input.hostCapabilities ?? [
      STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY,
      STRUCTURED_AGENT_SESSION_CLIENT_LAUNCH_MODE_CAPABILITY,
      STRUCTURED_AGENT_SESSION_REGISTERED_AGENTS_RUNTIME_CAPABILITY
    ],
    hostStructuredAgents: input.hostStructuredAgents ?? [input.agent]
  })
  if (!possible.supported) {
    return false
  }
  return input.hostCapabilities === null
    ? null
    : structuredAgentLaunchSupport(input).supported
      ? true
      : null
}

export function automationDraftSurface(
  draft: AutomationDraft,
  settings: GlobalSettings | null,
  chatSupported: boolean | null
): 'chat' | 'terminal' {
  return (
    draft.surface ??
    (chatSupported !== false && nativeChatPreferenceFor(settings, draft.agentId)
      ? 'chat'
      : 'terminal')
  )
}

export function automationDraftLaunchSetup(
  draft: Pick<AutomationDraft, 'extraAgentArgs'>,
  surface: 'chat' | 'terminal',
  currentAutomation: Automation | null
): Pick<AutomationUpdateInput, 'launchSetupPatch' | 'extraAgentArgs'> {
  const argumentsChanged =
    hasExtraAgentArgs(draft.extraAgentArgs) || currentAutomation?.extraAgentArgs
  return surface === 'chat' || currentAutomation?.surface === 'chat'
    ? {
        launchSetupPatch: {
          surface,
          ...(argumentsChanged
            ? { arguments: { kind: 'legacy-extras' as const, value: draft.extraAgentArgs } }
            : {})
        }
      }
    : argumentsChanged
      ? { extraAgentArgs: draft.extraAgentArgs }
      : {}
}
