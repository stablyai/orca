import { useAppStore } from '@/store/index'
import { translate } from '@/i18n/i18n'
import { activateAndRevealWorktree } from '@/lib/workspace/activation/worktree-activation'
import type { ActivateAndRevealResult } from '@/lib/workspace/activation/worktree-activation-outcome'
import { adoptAgentSessionLaunchVerdict } from '@/lib/agent-session/launch/routing/agent-session-launch-plan'
import type { AgentLaunchRoute } from '@/lib/agent-session/launch/routing/agent-launch-routing'
import {
  pendingCreationChatDraftScopeKey,
  withPendingChatInput,
  type WorktreeCreationRequest
} from '@/lib/workspace/creation/pending-worktree-creation'
import { beginStructuredAgentSessionProvisionalLaunch } from '@/lib/agent-session/structured-agent-session-provisional-tab'
import {
  moveWorktreeCreationDraftToTarget,
  readWorktreeCreationHandoffTarget,
  releaseFirstSendFilesWhenHeld
} from '@/lib/workspace/creation/worktree-creation-handoff-target'
import { hasDeferredNativeChatComposerNotice } from '@/components/native-chat/composer/controls/native-chat-deferred-composer-notice'
import { requestBackgroundTerminalWorktreeMount } from '@/components/terminal/workspace-mounting/background-terminal-worktree-mount'
import {
  nativeChatComposerSelection,
  waitForNativeChatComposerHandoff
} from '@/components/native-chat/composer/focus/native-chat-composer-mount'
import '@/components/native-chat/composer/focus/use-native-chat-composer-reveal-focus'
import { openBackgroundDeclinedTerminal } from '@/lib/workspace/creation/worktree-creation-background-mount'
import { settleAgentTabLaunch } from '@/lib/agent-session/launch/new-tab/launch-agent-in-new-tab-host-agents'
import { hasNativeChatStagedFiles } from '@/components/native-chat/drafts/native-chat-draft-attachment-staging'
import { captureNativeChatStagedInput } from '@/components/native-chat/drafts/native-chat-staged-input'
import { nativeChatComposerHasUserContent } from '@/components/native-chat/attachments/chips/native-chat-pending-attachment-cache'

const HANDOFF_READY_TIMEOUT_MS = 5000

export type WorktreeCreationStructuredSessionResult = {
  accepted: boolean
  cancelled: boolean
  retainedInput?: true
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
    worktreeId: args.worktreeId,
    chatInputHandedOff: true,
    chatHandedOffAt: Date.now()
  })
  const pending = useAppStore.getState().pendingWorktreeCreations[args.creationId]
  const request = withPendingChatInput(pending, {
    ...args.request,
    ...(pending?.request.launchInputs
      ? {
          launchInputs: { ...args.request.launchInputs, ...pending.request.launchInputs }
        }
      : {})
  })
  const promptAttachments = pending?.heldChatAttachments?.map(({ path, connectionId }) => ({
    path,
    previewUri: '',
    ...(connectionId ? { connectionId } : {})
  }))
  const sourceScope = pendingCreationChatDraftScopeKey(args.creationId)
  const prepareInput = captureNativeChatStagedInput(sourceScope, {
    text: request.launchDraftPrompt ?? request.quickPrompt,
    attachments: promptAttachments
  })
  // The composer's own input (typing, chips still saving, staged files), apart from the first send,
  // and a paste failure waiting for it: with no chat to show it, that may be the only feedback left.
  const sourceHoldsInput = (): boolean =>
    nativeChatComposerHasUserContent(sourceScope) ||
    hasNativeChatStagedFiles(sourceScope) ||
    hasDeferredNativeChatComposerNotice(sourceScope)
  const needsChat = (): boolean =>
    Boolean(promptAttachments?.length || pending?.heldChatSkills?.length) || sourceHoldsInput()
  const retainInput = (): WorktreeCreationStructuredSessionResult => {
    useAppStore.getState().updatePendingWorktreeCreation(args.creationId, {
      worktreeId: args.worktreeId,
      status: 'error',
      error: translate(
        'components.native-chat.creationChatNotOpened',
        'Your worktree is ready, but the chat could not open. Retry to open it with your message.'
      )
    })
    return { ...settled, retainedInput: true, activation, primaryTabId }
  }
  // Reuse composer-fixed route/delivery through retries; later host changes must not re-resolve this create.
  const plan = adoptAgentSessionLaunchVerdict({
    route: args.agentLaunchRoute,
    ...(needsChat() ? { requestedSurface: 'chat' as const } : {}),
    // One create is one user action: a retry of it re-delivers the same request.
    requestId: args.creationId,
    agent,
    ...(request.launchInputs?.sessionOptions
      ? { launchOptions: request.launchInputs.sessionOptions }
      : {}),
    ...(request.launchInputs?.chatSessionOptions !== undefined
      ? { chatLaunchOptions: request.launchInputs.chatSessionOptions }
      : {}),
    prompt: request.launchDraftPrompt ?? request.quickPrompt,
    promptAttachments,
    promptSkills: pending?.heldChatSkills,
    ...(hasNativeChatStagedFiles(sourceScope)
      ? {
          preparePrompt: async (sessionId, target) =>
            prepareInput.prepare(
              {
                text: request.launchDraftPrompt ?? request.quickPrompt,
                attachments: promptAttachments,
                skills: pending?.heldChatSkills
              },
              {
                sessionId,
                runtimeEnvironmentId: target.kind === 'environment' ? target.environmentId : null
              }
            )
        }
      : {}),
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
  // Set only once the source draft moved into the chat: a published tab alone does not prove it.
  let draftTransferred = false
  const handOffDraft = async (tabId: string | null): Promise<void> => {
    const tab = readWorktreeCreationHandoffTarget(tabId, args.worktreeId)
    if (!tab) {
      return
    }
    const state = useAppStore.getState()
    if (
      args.shouldActivateOnCompletion &&
      state.activeView === 'terminal' &&
      state.activePendingCreationId === args.creationId
    ) {
      requestBackgroundTerminalWorktreeMount({ worktreeId: args.worktreeId, tabIds: [tab.tabId] })
      await waitForNativeChatComposerHandoff(
        sourceScope,
        tab.tabId,
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
    // The tab may have closed, or its session or host changed, while the composer mounted.
    draftTransferred = moveWorktreeCreationDraftToTarget(
      tab,
      args.worktreeId,
      sourceScope,
      selection
    )
  }
  // The surfaces that took the input: a published chat, or (plain text only) a terminal.
  let chatOpened = false
  let reached = false
  // An open chat proves the first send landed, not that the composer's own input moved with it.
  const inputLost = (): boolean =>
    (chatOpened ? !draftTransferred && sourceHoldsInput() : needsChat()) ||
    (!reached && Boolean(plan.prompt?.trim()))
  try {
    const launch = beginStructuredAgentSessionProvisionalLaunch({
      plan,
      hooks: { signal: abandoned.signal },
      declinedTerminal: { agentArgs: args.request.launchInputs?.agentArgs },
      target: { worktreeId: args.worktreeId },
      activate: args.shouldActivateOnCompletion,
      ...(args.shouldActivateOnCompletion
        ? {}
        : {
            onHostDeclined: (host) =>
              openBackgroundDeclinedTerminal(
                { ...args, request },
                host,
                pending?.heldChatMessage,
                abandoned.signal
              )
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
    if (launch) {
      // Keep the pending chat until the layout owner's answering frame provides its replacement.
      primaryTabId = await tabOpen.promise
      if (primaryTabId !== null) {
        releaseFirstSendFilesWhenHeld(
          launch.promptDeliveryResult,
          () => draftTransferred,
          prepareInput
        )
      }
      if (abandoned.signal.aborted || isCancelled()) {
        launch.cancel()
        return { ...settled, cancelled: true, activation, primaryTabId }
      }
      chatOpened = primaryTabId !== null
      reached =
        chatOpened ||
        (!layoutRefused && launch.tab === null && (await launch.settlement).kind === 'terminal')
    }
    const stillVisible = (): boolean => {
      const state = useAppStore.getState()
      return (
        !activation &&
        state.activeView === 'terminal' &&
        state.activePendingCreationId === args.creationId
      )
    }
    if (
      launch &&
      args.shouldActivateOnCompletion &&
      !reached &&
      plan.prompt &&
      layoutRefused &&
      !needsChat()
    ) {
      const { launchAgentInNewTabWithOutcome } =
        await import('@/lib/agent-session/launch/new-tab/launch-agent-in-new-tab')
      if (abandoned.signal.aborted || isCancelled()) {
        launch.cancel()
        return { ...settled, cancelled: true, activation, primaryTabId }
      }
      const fallback = launchAgentInNewTabWithOutcome({
        agent,
        ...request.launchInputs,
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
      // A paired host accepts before it creates; only the created terminal holds the message.
      const settledFallback = await settleAgentTabLaunch(fallback)
      if (settledFallback.kind === 'terminal' && fallback && !('refused' in fallback)) {
        reached = true
        primaryTabId = fallback.surface.kind === 'local-terminal' ? fallback.surface.tabId : null
      }
    }
    if (inputLost() && !isCancelled()) {
      return retainInput()
    }
    if (launch && args.shouldActivateOnCompletion && stillVisible()) {
      activation = activateAndRevealWorktree(args.worktreeId, {
        providesInitialSurface: chatOpened || (reached && layoutRefused),
        worktreeCreationId: args.creationId
      })
      primaryTabId ??= activation === false ? null : activation.primaryTabId
    }
  } catch (error) {
    // Contain this fire-and-forget caller’s errors or the panel remains mid-create.
    console.error('worktree create: structured chat tab failed to open', args.worktreeId, error)
    if (inputLost() && !isCancelled()) {
      return retainInput()
    }
    return { ...settled, activation, primaryTabId }
  } finally {
    abandoned.signal.removeEventListener('abort', stopWaiting)
    unsubscribe()
  }
  return { ...settled, activation, primaryTabId }
}
