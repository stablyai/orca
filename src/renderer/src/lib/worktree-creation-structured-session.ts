import { useAppStore } from '@/store'
import { ensureWorktreeHasInitialTerminal } from '@/lib/worktree-initial-terminal-seeding'
import { activateAndRevealWorktree, type ActivateAndRevealResult } from '@/lib/worktree-activation'
import {
  cancelStructuredCodexLaunch,
  startStructuredCodexLaunch
} from '@/lib/structured-agent-session-launch'
import { StructuredAgentSessionCreateRefusalError } from '@/lib/launch-structured-codex-session'
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
  if (args.request.agent !== 'codex') {
    return { accepted, cancelled: false, visibilityUnknown, activation, primaryTabId }
  }
  if (!useAppStore.getState().pendingWorktreeCreations[args.creationId]) {
    return { accepted, cancelled: true, visibilityUnknown, activation, primaryTabId }
  }

  const launch = startStructuredCodexLaunch(
    args.worktreeId,
    args.recoverUnknownLaunch
      ? {}
      : { prompt: args.request.launchDraftPrompt ?? args.request.quickPrompt }
  )
  let cancelled = false
  const cancelLaunch = (): void => {
    if (cancelled) {
      return
    }
    cancelled = true
    cancelStructuredCodexLaunch(args.worktreeId, launch.sessionId)
  }
  const unsubscribe = useAppStore.subscribe((state) => {
    if (!state.pendingWorktreeCreations[args.creationId]) {
      cancelLaunch()
    }
  })
  if (!useAppStore.getState().pendingWorktreeCreations[args.creationId]) {
    cancelLaunch()
  }
  const refusalFallback = launch.claimDefinitiveRefusalFallback(async () => {
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
    if (args.shouldActivateOnCompletion) {
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
      await refusalFallback
    } else {
      visibilityUnknown = launch.isVisibilityUnknown()
      if (visibilityUnknown) {
        launch.releaseCallerAfterUnknownOutcome()
      }
    }
  } finally {
    unsubscribe()
  }
  return { accepted, cancelled, visibilityUnknown, activation, primaryTabId }
}
