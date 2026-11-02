/** A new workspace's chat on a host that owns its Setup wait: the creation names the host's launch
 *  once, hands the held message and the composer's own terminal plan to it, and keeps its input
 *  when this window could not show the chat. */

import { useAppStore } from '@/store'
import { translate } from '@/i18n/i18n'
import { createBrowserUuid } from '@/lib/browser-uuid'
import {
  pendingCreationChatDraftScopeKey,
  type PendingWorktreeCreation,
  type WorktreeCreationRequest
} from '@/lib/pending-worktree-creation'
import { buildWorktreeCreationStartupOpt } from '@/lib/worktree-creation-flow-startup'
import { isPendingCreationSurfaceVisible } from '@/lib/worktree-creation-completion'
import { structuredLaunchOwner } from '@/lib/agent-session/structured-agent-session-provisional-tab'
import { notifyExplicitChatFailure } from '@/lib/agent-session/launch/structured-agent-session-launch-admission'
import { structuredAgentLabel } from '@/lib/agent-session/launch/structured-agent-session-launch-label'
import type { StructuredHostLaunch } from '@/lib/agent-session/launch/structured-agent-session-host-launch'
import type { AgentLaunchRoute } from '@/lib/agent-launch-routing'
import {
  deleteNativeChatComposerDraft,
  readNativeChatComposerDraft,
  structuredAgentSessionDraftScopeKey,
  updateNativeChatComposerDraft
} from '@/components/native-chat/native-chat-composer-draft-store'
import { structuredAgentSessionHostSupports } from '@/runtime/structured-agent-session-client'
import { closeStructuredAgentSession } from '@/runtime/structured-agent-session-close'
import { AGENT_LAUNCH_ACCEPT_RUNTIME_CAPABILITY } from '../../../shared/agent-launch-runtime-capability'
import { createStructuredAgentSessionId } from '../../../shared/agent-session/structured-agent-session-create'
import { createStructuredAgentSessionOperationId } from '../../../shared/agent-session/lifecycle/structured-agent-session-mutation'
import type { TuiAgent } from '../../../shared/tui-agent'

type HostLaunchIdentity = NonNullable<PendingWorktreeCreation['hostLaunch']>

/** The launch a creation already handed to its host, or a new one when the host can own its Setup
 *  wait; absent on a host too old to, which keeps its shipped chat create. */
export async function worktreeHostLaunchIdentity(args: {
  creationId: string
  worktreeId: string
  agent: TuiAgent
  agentLaunchRoute: AgentLaunchRoute
}): Promise<HostLaunchIdentity | undefined> {
  // A request that reached a host never falls back to another route, whatever that host says now.
  const handedOff = useAppStore.getState().pendingWorktreeCreations[args.creationId]?.hostLaunch
  if (handedOff) {
    return handedOff
  }
  const owner = structuredLaunchOwner({ route: args.agentLaunchRoute }, args.worktreeId)
  if (
    !owner ||
    !(await structuredAgentSessionHostSupports(
      owner.target,
      AGENT_LAUNCH_ACCEPT_RUNTIME_CAPABILITY
    ))
  ) {
    return undefined
  }
  const identity = {
    operationId: createStructuredAgentSessionOperationId(createBrowserUuid),
    sessionId: createStructuredAgentSessionId(args.agent, createBrowserUuid)
  }
  useAppStore.getState().updatePendingWorktreeCreation(args.creationId, { hostLaunch: identity })
  return identity
}

/** What accept carries: the held message, and the composer's own terminal plan in case the host
 *  cannot run the chat. A background create leaves the message unsent in that terminal, as its
 *  terminal always has; a foreground one sends it. */
export function worktreeHostLaunch(
  identity: HostLaunchIdentity,
  request: WorktreeCreationRequest,
  prompt: string | undefined,
  foreground: boolean
): StructuredHostLaunch {
  const startup = buildWorktreeCreationStartupOpt(request, false)
  return {
    ...identity,
    accept: {
      ...(prompt?.trim() ? { prompt } : {}),
      presentation: foreground ? 'focused' : 'background',
      ...(startup
        ? {
            terminalStartup: {
              command: startup.command,
              ...(startup.env ? { env: startup.env } : {}),
              ...(startup.launchConfig ? { launchConfig: startup.launchConfig } : {}),
              ...(startup.startupCommandDelivery
                ? { startupCommandDelivery: startup.startupCommandDelivery }
                : {}),
              promptDelivery: foreground ? ('submit' as const) : ('draft' as const)
            }
          }
        : {})
    }
  }
}

/** The layout refused the chat's tab: the creation keeps its held message, takes back the draft the
 *  launch moved, and shows why, with a Retry that hands off into this same workspace again. */
export function keepPendingChatAfterRefusedHandoff(
  creationId: string,
  worktreeId: string,
  agent: TuiAgent,
  sessionId: string | undefined
): void {
  const launchScope = sessionId ? structuredAgentSessionDraftScopeKey(sessionId) : null
  const { text, document, pastedTextFiles, images } = readNativeChatComposerDraft(launchScope ?? '')
  if (launchScope && (text !== '' || images.length > 0)) {
    const draft = { text, images, ...(document ? { document } : {}) }
    updateNativeChatComposerDraft(
      pendingCreationChatDraftScopeKey(creationId),
      pastedTextFiles ? { ...draft, pastedTextFiles } : draft,
      'immediate'
    )
    deleteNativeChatComposerDraft(launchScope)
  }
  useAppStore.getState().updatePendingWorktreeCreation(creationId, {
    worktreeId,
    status: 'error',
    error: translate(
      'auto.components.tab.bar.QuickLaunchButton.chatUnavailableAfterSelection',
      "Couldn't start a {{value0}} chat.",
      { value0: structuredAgentLabel(agent) }
    ),
    chatInputHandedOff: false
  })
  if (!isPendingCreationSurfaceVisible(creationId)) {
    notifyExplicitChatFailure(agent)
  }
}

/** Dismissing a creation whose chat its host still owns closes that chat, so nothing starts later
 *  in a workspace the user walked away from; the host fences its launch on the close. */
export function closeDismissedHostLaunch(entry: PendingWorktreeCreation | undefined): void {
  const route = entry?.request.agentLaunchRoute
  const owner =
    entry?.hostLaunch && entry.worktreeId && route
      ? structuredLaunchOwner({ route }, entry.worktreeId)
      : null
  if (owner && entry?.hostLaunch) {
    closeStructuredAgentSession(owner.target, entry.hostLaunch.sessionId).catch((error) => {
      console.warn('[worktree-create] closing a dismissed chat launch failed', error)
    })
  }
}
