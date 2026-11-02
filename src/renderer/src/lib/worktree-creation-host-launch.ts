/** A new workspace's chat on a host that owns its Setup wait: the creation picks that route before
 *  it creates anything, names the host's launch once, hands it the held message and this creation's
 *  own terminal plan, and keeps its input when this window could not show the chat. */

import { useAppStore } from '@/store'
import { translate } from '@/i18n/i18n'
import { createBrowserUuid } from '@/lib/browser-uuid'
import {
  pendingCreationChatDraftScopeKey,
  type PendingWorktreeCreation,
  type WorktreeCreationRequest
} from '@/lib/pending-worktree-creation'
import { planWorktreeHostLaunchTerminal } from '@/lib/worktree-creation-host-launch-terminal'
import { runtimeTargetForRepoOwner } from '@/lib/repo-runtime-owner'
import { runtimeRpcTargetForAuthorityKey } from '@/runtime/runtime-client-target'
import { isPendingCreationSurfaceVisible } from '@/lib/worktree-creation-completion'
import { structuredLaunchOwner } from '@/lib/agent-session/structured-agent-session-provisional-tab'
import { notifyExplicitChatFailure } from '@/lib/agent-session/launch/structured-agent-session-launch-admission'
import { structuredAgentLabel } from '@/lib/agent-session/launch/structured-agent-session-launch-label'
import type { StructuredHostLaunch } from '@/lib/agent-session/launch/structured-agent-session-host-launch'
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
import { structuredAgentSessionSendBody } from '../../../shared/agent-session/requests/structured-agent-session-send-mutation'
import { AgentLaunchSetupReceipt } from '../../../shared/rpc-contract/agent-launch-accept-params'
import type { RuntimeClientTarget } from '../../../shared/runtime-client-target'
import type { TuiAgent } from '../../../shared/tui-agent'

type HostLaunchIdentity = NonNullable<PendingWorktreeCreation['hostLaunch']>

/** The host a creation runs on, reached as its create call reaches it. */
function creationHostTarget(request: WorktreeCreationRequest): RuntimeClientTarget | null {
  const hostId = request.workspaceRunContext?.hostId ?? request.executionHostId
  return hostId
    ? (runtimeRpcTargetForAuthorityKey(hostId) ?? { kind: 'local' })
    : runtimeTargetForRepoOwner(useAppStore.getState(), request.repoId)
}

/** Chosen before the workspace exists, once per creation: a host that owns its Setup wait gets the
 *  chat as its own launch, and an older one keeps the shipped chat create. A creation that chose
 *  the host's launch keeps it whatever its create reply says; one that did not never takes it up. */
export async function selectChatRoute(
  creationId: string,
  request: WorktreeCreationRequest
): Promise<boolean> {
  if (useAppStore.getState().pendingWorktreeCreations[creationId]?.hostLaunch) {
    return true
  }
  const target = creationHostTarget(request)
  if (
    !request.agent ||
    !target ||
    !(await structuredAgentSessionHostSupports(target, AGENT_LAUNCH_ACCEPT_RUNTIME_CAPABILITY)) ||
    !useAppStore.getState().pendingWorktreeCreations[creationId]
  ) {
    return false
  }
  useAppStore.getState().updatePendingWorktreeCreation(creationId, {
    hostLaunch: {
      operationId: createStructuredAgentSessionOperationId(createBrowserUuid),
      sessionId: createStructuredAgentSessionId(request.agent, createBrowserUuid),
      clientMessageId: createStructuredAgentSessionOperationId(createBrowserUuid)
    }
  })
  return true
}

/** What the creation's host said about the Setup the chat waits for. A reply without a readable
 *  word is uncertainty, never "nothing to wait for". */
export function recordChatSetupReceipt(creationId: string, reported: unknown): void {
  const hostLaunch = useAppStore.getState().pendingWorktreeCreations[creationId]?.hostLaunch
  if (!hostLaunch) {
    return
  }
  const parsed = AgentLaunchSetupReceipt.safeParse(reported)
  useAppStore.getState().updatePendingWorktreeCreation(creationId, {
    hostLaunch: {
      ...hostLaunch,
      setupReceipt: parsed.success ? parsed.data : { required: true, runId: null }
    }
  })
}

/** What accept carries: the held message under its own id, the creation's Setup receipt, and the
 *  terminal this creation's own path would open if the host cannot run the chat. The terminal is
 *  planned once, at the first handoff; a Retry sends the same launch. */
export function worktreeHostLaunch(args: {
  creationId: string
  identity: HostLaunchIdentity
  request: WorktreeCreationRequest
  worktreeId: string
  agent: TuiAgent
  prompt: string | undefined
  heldChatMessage: string | undefined
  foreground: boolean
}): StructuredHostLaunch {
  const { identity } = args
  const owner = structuredLaunchOwner({ route: 'structured-native-chat' }, args.worktreeId)
  const terminal =
    identity.terminal ??
    (owner
      ? planWorktreeHostLaunchTerminal({
          ...args,
          prompt: args.prompt ?? '',
          owner
        })
      : {})
  if (!identity.terminal) {
    useAppStore.getState().updatePendingWorktreeCreation(args.creationId, {
      hostLaunch: { ...identity, terminal }
    })
  }
  const text = args.prompt?.trim() ? args.prompt : undefined
  return {
    operationId: identity.operationId,
    sessionId: identity.sessionId,
    ...(text
      ? {
          firstMessage: {
            clientMessageId: identity.clientMessageId,
            body: structuredAgentSessionSendBody(text, [])
          }
        }
      : {}),
    accept: {
      ...(text ? { prompt: { text, clientMessageId: identity.clientMessageId } } : {}),
      presentation: args.foreground ? 'focused' : 'background',
      setupReceipt: identity.setupReceipt ?? { required: true, runId: null },
      ...(terminal.startup ? { terminalStartup: terminal.startup } : {}),
      ...(terminal.launchSource ? { launchSource: terminal.launchSource } : {})
    }
  }
}

/** The layout refused the chat's tab, or opening it threw: the creation keeps its held message,
 *  takes back the draft the launch moved, and shows why, with a Retry that hands off into this same
 *  workspace again. Out of view, the existing short notice says so without moving the user. */
export function keepPendingChatAfterRefusedHandoff(
  creationId: string,
  worktreeId: string,
  agent: TuiAgent,
  { sessionId }: Pick<StructuredHostLaunch, 'sessionId'>
): void {
  const launchScope = structuredAgentSessionDraftScopeKey(sessionId)
  const { text, document, pastedTextFiles, images } = readNativeChatComposerDraft(launchScope)
  if (text !== '' || images.length > 0) {
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
