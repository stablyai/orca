import { useAppStore } from '@/store'
import { ensureWorktreeHasInitialTerminal } from '@/lib/worktree-initial-terminal-seeding'
import { activateAndRevealWorktree, type ActivateAndRevealResult } from '@/lib/worktree-activation'
import {
  cancelStructuredAgentLaunch,
  startStructuredAgentLaunch
} from '@/lib/structured-agent-session-launch'
import { StructuredAgentSessionCreateRefusalError } from '@/lib/launch-structured-agent-session'
import { isAgentSessionHandleProvider } from '../../../shared/agent-session-provider-handle'
import { activateStructuredAgentSessionById } from '@/lib/structured-agent-session-tab-activation'
import { preflightAgentTrust } from '@/lib/agent-trust-preflight'
import type { WorktreeCreationRequest } from '@/lib/pending-worktree-creation'
import type { WorktreeStartupPayload } from '@/lib/worktree-startup-payload'
import { closeStructuredAgentSession } from '@/runtime/structured-agent-session-close'
import { callRuntimeRpc } from '@/runtime/runtime-rpc-client'
import { toRuntimeWorktreeSelector } from '@/runtime/runtime-worktree-selector'

export type WorktreeCreationStructuredSessionResult = {
  accepted: boolean
  cancelled: boolean
  visibilityUnknown: boolean
  promptDeliveryUnknown?: true
  failure?: 'launch-refused' | 'prompt-delivery'
  activation: ActivateAndRevealResult | false
  primaryTabId: string | null
}

async function retireCancelledStructuredSession(
  worktreeId: string,
  sessionId: string
): Promise<void> {
  const target = { kind: 'local' } as const
  await closeStructuredAgentSession(target, sessionId).catch(() => undefined)
  await callRuntimeRpc(target, 'session.tabs.close', {
    worktree: toRuntimeWorktreeSelector(worktreeId),
    tabId: `agent-session:${sessionId}`,
    reason: 'user'
  }).catch(() => undefined)
}

export async function launchStructuredWorktreeSession(args: {
  creationId: string
  request: WorktreeCreationRequest
  worktreeId: string
  shouldActivateOnCompletion: boolean
  fallbackStartupOpt: WorktreeStartupPayload | undefined
  activation: ActivateAndRevealResult | false
  primaryTabId: string | null
  recoverUnknownLaunch?: boolean
}): Promise<WorktreeCreationStructuredSessionResult> {
  let { activation, primaryTabId } = args
  let accepted = true
  let visibilityUnknown = false
  let failure: WorktreeCreationStructuredSessionResult['failure']
  const agent = args.request.agent
  if (!isAgentSessionHandleProvider(agent)) {
    return { accepted, cancelled: false, visibilityUnknown, activation, primaryTabId }
  }
  if (!useAppStore.getState().pendingWorktreeCreations[args.creationId]) {
    return { accepted, cancelled: true, visibilityUnknown, activation, primaryTabId }
  }

  const strictWorkItemLaunch = args.request.workItemStartPromptDelivery === 'submit-after-ready'
  const prompt = args.request.launchDraftPrompt ?? args.request.quickPrompt
  const launch = startStructuredAgentLaunch(args.worktreeId, agent, {
    ...(strictWorkItemLaunch || !args.recoverUnknownLaunch ? { prompt } : {}),
    ...(strictWorkItemLaunch
      ? {
          promptDelivery: 'submit-after-ready' as const,
          launchOrigin: 'work-item-start' as const,
          ...(args.recoverUnknownLaunch ? { reuseStagedPrompt: true } : {})
        }
      : {})
  })
  let cancelled = false
  const cancelLaunch = (): void => {
    if (cancelled) {
      return
    }
    cancelled = true
    cancelStructuredAgentLaunch(args.worktreeId, launch.sessionId)
  }
  const unsubscribe = useAppStore.subscribe((state) => {
    if (!state.pendingWorktreeCreations[args.creationId]) {
      cancelLaunch()
    }
  })
  if (!useAppStore.getState().pendingWorktreeCreations[args.creationId]) {
    cancelLaunch()
  }
  const refusalFallback = strictWorkItemLaunch
    ? null
    : launch.claimDefinitiveRefusalFallback(async () => {
        accepted = false
        if (cancelled) {
          return
        }
        if (args.request.pendingFirstAgentMessageRename) {
          await useAppStore
            .getState()
            .updateWorktreeMeta(args.worktreeId, { pendingFirstAgentMessageRename: true })
            .catch(() => undefined)
        }
        if (cancelled) {
          return
        }
        const worktree = useAppStore
          .getState()
          .allWorktrees?.()
          .find((candidate) => candidate.id === args.worktreeId)
        if (args.request.agent && worktree?.path) {
          const repoConnectionId = useAppStore
            .getState()
            .repos.find((repo) => repo.id === args.request.repoId)?.connectionId
          await preflightAgentTrust({
            agent: args.request.agent,
            workspacePath: worktree.path,
            connectionId: repoConnectionId
          })
        }
        if (cancelled) {
          return
        }
        if (args.shouldActivateOnCompletion) {
          const fallbackActivation = activateAndRevealWorktree(args.worktreeId, {
            sidebarRevealBehavior: 'auto',
            createNewTerminalForStartup: true,
            ...(args.fallbackStartupOpt ? { startup: args.fallbackStartupOpt } : {})
          })
          activation = fallbackActivation
          primaryTabId = fallbackActivation === false ? null : fallbackActivation.primaryTabId
          return
        }
        primaryTabId = ensureWorktreeHasInitialTerminal(
          useAppStore.getState(),
          args.worktreeId,
          args.fallbackStartupOpt,
          undefined,
          undefined,
          undefined,
          { activateCreatedTabs: false, createNewTerminalForStartup: true }
        )
      })

  try {
    const receipt = await launch.launchResult
    if (cancelled) {
      await retireCancelledStructuredSession(args.worktreeId, launch.sessionId)
      return { accepted, cancelled, visibilityUnknown, activation, primaryTabId }
    }
    if (strictWorkItemLaunch) {
      const promptDelivery = await launch.promptDeliveryResult
      if (cancelled) {
        await retireCancelledStructuredSession(args.worktreeId, launch.sessionId)
        return { accepted, cancelled, visibilityUnknown, activation, primaryTabId }
      }
      if (promptDelivery?.delivered !== true) {
        if (promptDelivery?.deliveryUnknown) {
          return {
            accepted,
            cancelled,
            visibilityUnknown,
            promptDeliveryUnknown: true,
            activation,
            primaryTabId
          }
        }
        failure = 'prompt-delivery'
        return {
          accepted,
          cancelled,
          visibilityUnknown,
          failure,
          activation,
          primaryTabId
        }
      }
    }
    if (args.shouldActivateOnCompletion) {
      // Chat selection requires its workspace to be active.
      if (!activation) {
        activation = activateAndRevealWorktree(args.worktreeId, { providesInitialSurface: true })
        primaryTabId = activation === false ? null : activation.primaryTabId
      }
      activateStructuredAgentSessionById({
        worktreeId: args.worktreeId,
        sessionId: receipt.sessionId
      })
    }
  } catch (error) {
    if (cancelled) {
      await retireCancelledStructuredSession(args.worktreeId, launch.sessionId)
      return { accepted, cancelled, visibilityUnknown, activation, primaryTabId }
    }
    if (error instanceof StructuredAgentSessionCreateRefusalError) {
      if (strictWorkItemLaunch) {
        accepted = false
        failure = 'launch-refused'
      } else {
        await refusalFallback
      }
    } else {
      visibilityUnknown = launch.isVisibilityUnknown()
      if (visibilityUnknown) {
        launch.releaseCallerAfterUnknownOutcome()
      }
    }
  } finally {
    unsubscribe()
  }
  return {
    accepted,
    cancelled,
    visibilityUnknown,
    ...(failure ? { failure } : {}),
    activation,
    primaryTabId
  }
}
