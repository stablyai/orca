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
 * Best-effort surface repair for the one branch that has no other way back: activation owns
 * both revealing the workspace and naming its primary tab, so when it throws the created
 * workspace can be left with nothing to deliver agent startup to. Never throws — settlement
 * must not depend on recovery succeeding either.
 */
function recoverRevealedWorkspaceSurface(
  args: WorktreePostCreateStepsArgs,
  progress: PostCreateProgress
): void {
  // Only the activating branch loses its surface to a throw; the others established theirs
  // before the failing step, and a structured launch owns its own.
  if (!args.shouldActivateOnCompletion || args.structuredLaunch || progress.primaryTabId !== null) {
    return
  }
  const { request, result } = args
  try {
    const state = useAppStore.getState()
    const existingTabs = state.tabsByWorktree[args.worktreeId] ?? []
    const launchAgent = args.startupOpt?.launchAgent ?? request.agent
    // Activation can publish the worktree before it throws. Do not infer a primary tab from
    // default-tab ordering; only the backend startup terminal or an agent-stamped tab is safe.
    const verifiedLaunchTabId =
      result.startupTerminal?.tabId ??
      (launchAgent ? existingTabs.find((tab) => tab.launchAgent === launchAgent)?.id : undefined)
    if (verifiedLaunchTabId) {
      progress.primaryTabId = verifiedLaunchTabId
    } else if (existingTabs.length === 0) {
      progress.primaryTabId = ensureWorktreeHasInitialTerminal(
        state,
        args.worktreeId,
        args.startupOpt,
        result.setup,
        request.issueCommand,
        result.defaultTabs,
        {
          ...(request.agent !== null ? { callerProvidesSurface: true } : {}),
          ...(args.backendSpawned ? { backendStartupTerminalSpawned: true } : {})
        }
      )
    }
    if (!args.backendSpawned) {
      ensureWebRuntimeWorktreeTerminalAfterWake(args.worktreeId, {
        startup: args.startupOpt,
        agent: request.agent
      })
    }
  } catch (error) {
    console.error('worktree create: post-create recovery failed', args.worktreeId, error)
  }
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
    recoverRevealedWorkspaceSurface(args, progress)
    return { kind: 'complete', ...progress }
  }
}
