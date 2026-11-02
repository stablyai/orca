import { useAppStore } from '@/store'
import { activateAndRevealWorktree, type ActivateAndRevealResult } from '@/lib/worktree-activation'
import { adoptAgentSessionLaunchVerdict } from '@/lib/agent-session-launch-plan'
import type { AgentLaunchRoute } from '@/lib/agent-launch-routing'
import {
  pendingCreationChatDraftScopeKey,
  withPendingChatInput,
  type WorktreeCreationRequest
} from '@/lib/pending-worktree-creation'
import { beginStructuredAgentSessionProvisionalLaunch } from '@/lib/agent-session/structured-agent-session-provisional-tab'
import { moveStructuredAgentLaunchDraft } from '@/lib/agent-session/launch/structured-agent-session-launch-draft'
import { getStructuredAgentSessionLaunchOwner } from '@/lib/agent-session/launch/structured-agent-session-launch-registry'
import { requestBackgroundTerminalWorktreeMount } from '@/components/terminal/background-terminal-worktree-mount'
import {
  nativeChatComposerSelection,
  waitForNativeChatComposerHandoff
} from '@/components/native-chat/native-chat-composer-mount'
import { captureNativeChatComposerFocusIntent } from '@/components/native-chat/use-native-chat-composer-reveal-focus'
import type { StructuredLaunchTerminal } from '@/lib/agent-session/launch/structured-agent-session-launch-admission'
import { buildWorktreeCreationStartupOpt } from '@/lib/worktree-creation-flow-startup'
import { ensureWebRuntimeWorktreeTerminalAfterWake } from '@/lib/web-runtime-worktree-terminal-after-wake'
import { ensureWorktreeHasInitialTerminal } from '@/lib/worktree-initial-terminal-seeding'
import { mountCreatedWorktreeStartupTabsInBackground } from '@/lib/worktree-creation-background-mount'
import type { RuntimeClientTarget } from '../../../shared/runtime-client-target'

const HANDOFF_READY_TIMEOUT_MS = 5000

export type WorktreeCreationStructuredSessionResult = {
  accepted: boolean
  cancelled: boolean
  activation: ActivateAndRevealResult | false
  primaryTabId: string | null
}

type LaunchStructuredWorktreeSessionArgs = {
  creationId: string
  request: WorktreeCreationRequest
  /** Required: a non-structured route opens no session here, so the caller must have gated on it. */
  agentLaunchRoute: AgentLaunchRoute
  worktreeId: string
  shouldActivateOnCompletion: boolean
  activation: ActivateAndRevealResult | false
  primaryTabId: string | null
}

/** Host-declined chats keep background creates in place without navigation (#23974); still-visible creates use normal agent-tab fallback. */
function openBackgroundDeclinedTerminal(
  args: LaunchStructuredWorktreeSessionArgs,
  host: RuntimeClientTarget,
  heldChatMessage: string | undefined
): StructuredLaunchTerminal {
  const built = buildWorktreeCreationStartupOpt(args.request, false)
  // The submit-time plan never saw a message sent while the worktree was created; leave it unsent in the agent's input.
  const startup =
    built && heldChatMessage && !built.draftPrompt
      ? { ...built, draftPrompt: heldChatMessage }
      : built
  if (host.kind === 'environment') {
    ensureWebRuntimeWorktreeTerminalAfterWake(args.worktreeId, {
      startup,
      agent: args.request.agent,
      activate: false
    })
    return { opened: true }
  }
  if (!startup) {
    return { opened: false }
  }
  // This machine seeds the agent terminal itself; a background workspace mounts it without showing it.
  const tabId = ensureWorktreeHasInitialTerminal(
    useAppStore.getState(),
    args.worktreeId,
    startup,
    undefined,
    undefined,
    undefined,
    { activateCreatedTabs: false, createNewTerminalForStartup: true }
  )
  mountCreatedWorktreeStartupTabsInBackground(args.worktreeId)
  return { opened: tabId !== null }
}

export async function launchStructuredWorktreeSession(
  args: LaunchStructuredWorktreeSessionArgs
): Promise<WorktreeCreationStructuredSessionResult> {
  let { activation, primaryTabId } = args
  const settled = { accepted: true, cancelled: false }
  const { agent } = args.request
  // The composer's route already asked the host whether it runs this agent as a chat.
  if (!agent || args.agentLaunchRoute !== 'structured-native-chat') {
    return { ...settled, activation, primaryTabId }
  }
  const isCancelled = (): boolean =>
    !useAppStore.getState().pendingWorktreeCreations[args.creationId]
  if (isCancelled()) {
    return { ...settled, cancelled: true, activation, primaryTabId }
  }
  // Freeze the first send; unsent typing stays with the composer until its replacement is ready.
  useAppStore.getState().updatePendingWorktreeCreation(args.creationId, {
    chatInputHandedOff: true
  })
  const pending = useAppStore.getState().pendingWorktreeCreations[args.creationId]
  const request = withPendingChatInput(pending, args.request)
  // Reuse composer-fixed route/delivery through retries; later host changes must not re-resolve this create.
  const plan = adoptAgentSessionLaunchVerdict({
    route: args.agentLaunchRoute,
    // One create is one user action: a retry of it re-delivers the same request.
    requestId: args.creationId,
    agent,
    prompt: request.launchDraftPrompt ?? request.quickPrompt,
    ...(request.promptDelivery ? { promptDelivery: request.promptDelivery } : {})
  })
  let layoutRefused = false
  const abandoned = new AbortController()
  const revealAbandoned = new AbortController()
  const tabOpen = Promise.withResolvers<string | null>()
  const stopWaiting = (): void => tabOpen.resolve(null)
  abandoned.signal.addEventListener('abort', stopWaiting, { once: true })
  const unsubscribe = useAppStore.subscribe((state) => {
    if (state.activeView !== 'terminal' || state.activePendingCreationId !== args.creationId) {
      revealAbandoned.abort()
    }
    if (!state.pendingWorktreeCreations[args.creationId]) {
      abandoned.abort()
      revealAbandoned.abort()
    }
  })
  const handOffDraft = async (tabId: string | null): Promise<void> => {
    const tab = tabId ? useAppStore.getState().getTab(tabId) : null
    if (tab?.contentType !== 'agent-session') {
      return
    }
    const sourceScope = pendingCreationChatDraftScopeKey(args.creationId)
    const state = useAppStore.getState()
    if (
      args.shouldActivateOnCompletion &&
      state.activeView === 'terminal' &&
      state.activePendingCreationId === args.creationId
    ) {
      requestBackgroundTerminalWorktreeMount({ worktreeId: args.worktreeId, tabIds: [tab.id] })
      await waitForNativeChatComposerHandoff(
        sourceScope,
        tab.id,
        revealAbandoned.signal,
        HANDOFF_READY_TIMEOUT_MS
      )
    }
    if (abandoned.signal.aborted) {
      return
    }
    const selection = revealAbandoned.signal.aborted
      ? undefined
      : nativeChatComposerSelection(sourceScope)
    if (selection) {
      captureNativeChatComposerFocusIntent().request(tab.id)
    }
    const executionHostId =
      tab.executionHostId ?? getStructuredAgentSessionLaunchOwner(tab.entityId)
    if (executionHostId) {
      moveStructuredAgentLaunchDraft(
        { sessionId: tab.entityId, worktreeId: args.worktreeId, executionHostId },
        sourceScope,
        selection
      )
    }
  }
  try {
    const launch = beginStructuredAgentSessionProvisionalLaunch({
      plan,
      hooks: { signal: abandoned.signal },
      target: { worktreeId: args.worktreeId },
      activate: args.shouldActivateOnCompletion,
      ...(args.shouldActivateOnCompletion
        ? {}
        : {
            onHostDeclined: (host) =>
              openBackgroundDeclinedTerminal(args, host, pending?.heldChatMessage)
          }),
      beforeOpen: () => !abandoned.signal.aborted && !isCancelled(),
      onTabOpenSettled: (tabId, reason) => {
        layoutRefused = reason === 'layout-refused'
        void handOffDraft(tabId).then(
          () => tabOpen.resolve(tabId),
          (error: unknown) => {
            console.error('worktree create: draft handoff failed', args.worktreeId, error)
            tabOpen.resolve(tabId)
          }
        )
      }
    })
    if (launch && args.shouldActivateOnCompletion) {
      // Keep the pending chat until the layout owner's answering frame provides its replacement.
      primaryTabId = await tabOpen.promise
      if (abandoned.signal.aborted || isCancelled()) {
        launch.cancel()
        return { ...settled, cancelled: true, activation, primaryTabId }
      }
      const stillVisible = (): boolean => {
        const state = useAppStore.getState()
        return (
          !activation &&
          state.activeView === 'terminal' &&
          state.activePendingCreationId === args.creationId
        )
      }
      let recoveryProvidesSurface = false
      if (primaryTabId === null && plan.prompt && layoutRefused) {
        const { launchAgentInNewTabWithOutcome } = await import('@/lib/launch-agent-in-new-tab')
        if (abandoned.signal.aborted || isCancelled()) {
          launch.cancel()
          return { ...settled, cancelled: true, activation, primaryTabId }
        }
        const fallback = launchAgentInNewTabWithOutcome({
          agent,
          worktreeId: args.worktreeId,
          prompt: plan.prompt,
          promptDelivery: plan.promptDelivery,
          activate: stillVisible(),
          agentSessionLaunchPlan: adoptAgentSessionLaunchVerdict({
            route: 'terminal-tui',
            requestId: args.creationId,
            agent,
            worktreeId: args.worktreeId
          })
        })
        if (fallback && !('refused' in fallback)) {
          recoveryProvidesSurface = true
          primaryTabId = fallback.surface.kind === 'local-terminal' ? fallback.surface.tabId : null
        }
      }
      if (stillVisible()) {
        activation = activateAndRevealWorktree(args.worktreeId, {
          providesInitialSurface: primaryTabId !== null || recoveryProvidesSurface,
          worktreeCreationId: args.creationId
        })
        primaryTabId ??= activation === false ? null : activation.primaryTabId
      }
    } else if (launch) {
      primaryTabId = (await tabOpen.promise) ?? launch.tab?.id ?? primaryTabId
    }
  } catch (error) {
    // Contain this fire-and-forget caller’s errors or the panel remains mid-create.
    console.error('worktree create: structured chat tab failed to open', args.worktreeId, error)
    return { ...settled, activation, primaryTabId }
  } finally {
    abandoned.signal.removeEventListener('abort', stopWaiting)
    unsubscribe()
  }
  return { ...settled, activation, primaryTabId }
}
