import { useAppStore } from '@/store'
import { activateAndRevealWorktree, type ActivateAndRevealResult } from '@/lib/worktree-activation'
import { ensureWorktreeHasInitialTerminal } from '@/lib/worktree-initial-terminal-seeding'
import { ensureWebRuntimeWorktreeTerminalAfterWake } from '@/lib/web-runtime-worktree-terminal-after-wake'
import { launchStructuredWorktreeSession } from '@/lib/worktree-creation-structured-session'
import { isAgentSessionHandleProvider } from '../../../shared/agent-session-provider-handle'
import type { CreateWorktreeResult } from '../../../shared/worktree/create-types'
import type { WorktreeCreationRequest } from '@/lib/pending-worktree-creation'
import type { WorktreeStartupPayload } from '@/lib/worktree-startup-payload'

/** How the created workspace settled. Every variant names one settlement the caller owes. */
export type WorktreePostCreateOutcome =
  | {
      kind: 'complete'
      activation: ActivateAndRevealResult | false
      primaryTabId: string | null
      structuredLaunchAccepted: boolean
    }
  /** Abandoned mid-flight: the cancel path already removed the pending entry. */
  | { kind: 'cancelled' }
  /** Structured chat may or may not have opened; the entry must stay for the retry affordance. */
  | { kind: 'awaiting-visibility' }

export type WorktreePostCreateStepsArgs = {
  creationId: string
  request: WorktreeCreationRequest
  result: CreateWorktreeResult
  worktreeId: string
  structuredLaunch: boolean
  backendSpawned: boolean
  shouldActivateOnCompletion: boolean
  startupOpt: WorktreeStartupPayload | undefined
  fallbackStartupOpt: WorktreeStartupPayload | undefined
}

/** Carries what already landed out of a step that throws, so settlement keeps it. */
type PostCreateProgress = {
  activation: ActivateAndRevealResult | false
  primaryTabId: string | null
  structuredLaunchAccepted: boolean
}

function openCreatedWorkspaceSurface(
  args: WorktreePostCreateStepsArgs,
  progress: PostCreateProgress
): void {
  const { request, result } = args
  if (args.shouldActivateOnCompletion && !args.structuredLaunch) {
    const activation = activateAndRevealWorktree(args.worktreeId, {
      sidebarRevealBehavior: 'auto',
      ...(request.agent !== null ? { agent: request.agent } : {}),
      ...(result.setup ? { setup: result.setup } : {}),
      ...(result.defaultTabs ? { defaultTabs: result.defaultTabs } : {}),
      ...(args.startupOpt ? { startup: args.startupOpt } : {}),
      ...(request.issueCommand ? { issueCommand: request.issueCommand } : {}),
      ...(args.backendSpawned ? { backendStartupTerminalSpawned: true } : {})
    })
    progress.activation = activation
    progress.primaryTabId = activation === false ? null : activation.primaryTabId
    return
  }
  // Keep chat creation on its pending surface until the session is ready.
  const hasExplicitTerminalWork = Boolean(
    args.startupOpt || result.setup || request.issueCommand || result.defaultTabs
  )
  progress.primaryTabId =
    request.agent !== null && !hasExplicitTerminalWork
      ? null
      : ensureWorktreeHasInitialTerminal(
          useAppStore.getState(),
          args.worktreeId,
          args.startupOpt,
          result.setup,
          request.issueCommand,
          result.defaultTabs,
          {
            activateCreatedTabs: false,
            ...(request.agent !== null ? { callerProvidesSurface: true } : {}),
            ...(args.backendSpawned ? { backendStartupTerminalSpawned: true } : {})
          }
        )
  if (!args.structuredLaunch && !args.backendSpawned) {
    ensureWebRuntimeWorktreeTerminalAfterWake(args.worktreeId, {
      startup: args.startupOpt,
      agent: request.agent,
      activate: false
    })
  }
}

async function settleCreatedWorkspace(
  args: WorktreePostCreateStepsArgs,
  progress: PostCreateProgress
): Promise<WorktreePostCreateOutcome> {
  openCreatedWorkspaceSurface(args, progress)
  const { agentLaunchRoute } = args.request
  if (
    agentLaunchRoute !== 'structured-native-chat' ||
    !isAgentSessionHandleProvider(args.request.agent)
  ) {
    return { kind: 'complete', ...progress }
  }
  const structuredSession = await launchStructuredWorktreeSession({
    creationId: args.creationId,
    request: args.request,
    agentLaunchRoute,
    worktreeId: args.worktreeId,
    shouldActivateOnCompletion: args.shouldActivateOnCompletion,
    fallbackStartupOpt: args.fallbackStartupOpt,
    activation: progress.activation,
    primaryTabId: progress.primaryTabId
  })
  progress.structuredLaunchAccepted = structuredSession.accepted
  progress.activation = structuredSession.activation
  progress.primaryTabId = structuredSession.primaryTabId
  if (structuredSession.cancelled) {
    return { kind: 'cancelled' }
  }
  if (structuredSession.visibilityUnknown) {
    return { kind: 'awaiting-visibility' }
  }
  return { kind: 'complete', ...progress }
}

/**
 * Runs every step that follows a resolved `createWorktree` and reports how the workspace
 * settled. Never throws: the worktree already exists on disk and its row is already in the
 * store, so a failed follow-up step still has to settle the creation and show the workspace
 * rather than strand the creation surface over it. Steps added here inherit that guarantee.
 */
export async function runWorktreePostCreateSteps(
  args: WorktreePostCreateStepsArgs
): Promise<WorktreePostCreateOutcome> {
  const progress: PostCreateProgress = {
    activation: false,
    primaryTabId: null,
    structuredLaunchAccepted: args.structuredLaunch
  }
  try {
    return await settleCreatedWorkspace(args, progress)
  } catch (error) {
    console.error('worktree create: post-create step failed', args.worktreeId, error)
    return { kind: 'complete', ...progress }
  }
}
