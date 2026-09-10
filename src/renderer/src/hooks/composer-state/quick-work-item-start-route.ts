import type { GlobalSettings } from '../../../../shared/global-settings-types'
import type { WorkItemStartPromptDelivery } from '../../../../shared/work-item-start-prompt-delivery'
import { resolveWorkItemStartPromptDelivery } from '../../../../shared/work-item-start-prompt-delivery'
import {
  resolveStructuredNativeChatSupport,
  type StructuredNativeChatBlocker
} from '../../../../shared/structured-native-chat-launch-route'
import type { TuiAgent } from '../../../../shared/tui-agent'
import {
  hasExplicitTuiLaunchCustomization,
  resolveAgentLaunchRoute,
  type AgentLaunchRoute,
  type AgentLaunchRoutingInput
} from '@/lib/agent-launch-routing'
import { getLocalRepoProjectExecutionRuntimeContext } from '@/lib/local-preflight-context'
import {
  readLocalRuntimeCapabilitiesOrUnknown,
  refreshLocalRuntimeCapabilities
} from '@/runtime/local-runtime-capabilities'
import { useAppStore } from '@/store'

type QuickWorkItemStartRouteInput = Omit<AgentLaunchRoutingInput, 'agent' | 'promptDelivery'> & {
  agent: TuiAgent | null
  hasLinkedWorkItem: boolean
  settings: GlobalSettings | null | undefined
  hasDraftPrompt: boolean
}

export type QuickWorkItemStartRouteResolution =
  | {
      ok: true
      route: AgentLaunchRoute
      workItemPromptDelivery?: WorkItemStartPromptDelivery
    }
  | {
      ok: false
      blocker: StructuredNativeChatBlocker
      workItemPromptDelivery: 'submit-after-ready'
    }

export function resolveQuickWorkItemStartRoute(
  input: QuickWorkItemStartRouteInput
): QuickWorkItemStartRouteResolution {
  const workItemPromptDelivery = input.hasLinkedWorkItem
    ? resolveWorkItemStartPromptDelivery(input.settings?.workItemStartPromptDelivery)
    : undefined
  if (workItemPromptDelivery === 'submit-after-ready') {
    const support = input.agent
      ? resolveStructuredNativeChatSupport({
          agent: input.agent,
          executionHostId: input.executionHostId,
          hostCapabilities: input.hostCapabilities,
          workspaceKind: input.workspaceKind,
          projectRuntime: input.projectRuntime,
          requiresTuiLaunchCustomization: input.requiresTuiLaunchCustomization
        })
      : ({ supported: false, blocker: 'agent-without-structured-session' } as const)
    return support.supported
      ? { ok: true, route: 'structured-native-chat', workItemPromptDelivery }
      : { ok: false, blocker: support.blocker, workItemPromptDelivery }
  }

  const route = input.agent
    ? resolveAgentLaunchRoute({
        ...input,
        agent: input.agent,
        promptDelivery: input.hasDraftPrompt ? 'draft' : 'auto-submit'
      })
    : 'terminal-tui'
  return {
    ok: true,
    route,
    ...(workItemPromptDelivery ? { workItemPromptDelivery } : {})
  }
}

export async function prepareQuickWorkItemStartRoute(args: {
  agent: TuiAgent | null
  hasLinkedWorkItem: boolean
  settings: GlobalSettings | null | undefined
  executionHostId: string
  repoId: string
  platform: NodeJS.Platform
  workspaceKind: 'git-worktree' | 'folder'
  hasDraftPrompt: boolean
  launchText: string
  nativeChatTranscriptIsLocalReadable: boolean
  initialSessionOptions?: Readonly<Record<string, unknown>>
}): Promise<QuickWorkItemStartRouteResolution> {
  const delivery = args.hasLinkedWorkItem
    ? resolveWorkItemStartPromptDelivery(args.settings?.workItemStartPromptDelivery)
    : undefined
  if (
    delivery === 'submit-after-ready' &&
    args.executionHostId === 'local' &&
    readLocalRuntimeCapabilitiesOrUnknown() === null
  ) {
    await refreshLocalRuntimeCapabilities()
  }
  return resolveQuickWorkItemStartRoute({
    ...args,
    hostCapabilities: readLocalRuntimeCapabilitiesOrUnknown(),
    projectRuntime: getLocalRepoProjectExecutionRuntimeContext(
      useAppStore.getState(),
      args.repoId,
      args.platform
    ),
    requiresTuiLaunchCustomization:
      args.agent !== null && hasExplicitTuiLaunchCustomization(args.settings, args.agent)
  })
}
