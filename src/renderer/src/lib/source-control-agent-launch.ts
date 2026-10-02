/**
 * Starts a source-control AI button's agent through the host's `agent.launch`.
 *
 * The button states the agent, the workspace and the generated prompt; the host decides whether it
 * runs as a chat or a terminal agent and how the prompt reaches it (on the launch command when the
 * typed line can carry it, else pasted once the agent is ready). This side only places and focuses
 * the tab the host reveals and reports the receipt back to the button.
 */

import { toast } from 'sonner'
import { useAppStore } from '@/store'
import { translate } from '@/i18n/i18n'
import { showAgentLaunchPromptNotDeliveredNotice } from '@/lib/agent-launch-prompt-not-delivered-notice'
import { showAgentLaunchStartedElsewhereNotice } from '@/lib/agent-launch-started-elsewhere-notice'
import { isWorkspaceInTerminalView } from '@/lib/workspace-terminal-view'
import { initialAgentTabViewModeProps } from '@/lib/native-chat-initial-view-mode'
import { isNativeChatTranscriptLocalReadable } from '@/lib/native-chat-transcript-readability'
import { getConnectionIdFromState } from '@/lib/connection-context'
import { getRuntimeEnvironmentIdForWorktree } from '@/lib/worktree-runtime-owner'
import { resolveInitialNativeChatSessionOptions } from '@/components/native-chat/native-chat-launch-session-options'
import { isWebRuntimeSessionActive } from '@/runtime/web-runtime-session'
import { ensureLocalRuntimeCapabilities } from '@/runtime/local-runtime-capabilities'
import {
  callRuntimeRpc,
  RuntimeRpcCallError,
  runtimeEnvironmentSupportsCapability,
  type RuntimeClientTarget
} from '@/runtime/runtime-rpc-client'
import { createAgentSessionOperationId } from '@/runtime/agent-session-operation-id'
import { isAmbiguousCreateFailure } from '@/runtime/agent-session-create-operation'
import { placeAgentLaunchTab } from '@/lib/agent-launch-tab-placement'
import { createBrowserUuid } from '@/lib/browser-uuid'
import { isAgentLaunchResult, type AgentLaunchResult } from '../../../shared/agent-launch-intent'
import { classifyAgentLaunchReplayRefusal } from '../../../shared/agent-launch-replay-refusal'
import { isRecoverableRemoteRuntimeConnectionError } from '../../../shared/remote-runtime-client-error-classification'
import type { RuntimeCapability } from '../../../shared/protocol-version'
import {
  AGENT_LAUNCH_PROMPT_CARRY_RUNTIME_CAPABILITY,
  AGENT_LAUNCH_REPLAY_REQUIRED_RUNTIME_CAPABILITY
} from '../../../shared/agent-launch-runtime-capability'
import { isAgentSessionHandleProvider } from '../../../shared/agent-session-provider-handle'
import { createStructuredAgentSessionId } from '../../../shared/structured-agent-session-create'
import { makePaneKey } from '../../../shared/stable-pane-id'
import type { TuiAgent } from '../../../shared/tui-agent'
import type { LaunchSource } from '../../../shared/telemetry-events'

/** The host waits up to 60 s for the agent before pasting; the reply must outlive that. */
const PROMPTED_AGENT_LAUNCH_TIMEOUT_MS = 90_000
/** One send and two replays under the same operation id, the renderer's create budget plus one. */
const MAX_LAUNCH_ATTEMPTS = 3

const REQUIRED_HOST_CAPABILITIES: readonly RuntimeCapability[] = [
  AGENT_LAUNCH_REPLAY_REQUIRED_RUNTIME_CAPABILITY,
  AGENT_LAUNCH_PROMPT_CARRY_RUNTIME_CAPABILITY
]

export type SourceControlAgentLaunchArgs = {
  agent: TuiAgent
  worktreeId: string
  prompt: string
  /** Absent uses the settings default; `null` means no arguments. */
  agentArgs?: string | null
  launchSource: LaunchSource
  /** The agent's surface exists; its prompt may still be on the way. */
  onLaunchAccepted?: () => void
  /** Runs once the host is known to take the launch and the tab's group is held, before anything
   *  is sent; false aborts. */
  beforeLaunch?: () => boolean
}

export type SourceControlAgentLaunchResult =
  /** This host cannot take the launch; nothing ran, so the caller's older path is safe. */
  | { kind: 'unsupported' }
  /** `beforeLaunch` declined; nothing ran. */
  | { kind: 'aborted' }
  | {
      kind: 'launched'
      /** False when the host kept the prompt; the agent is running without it. */
      promptDelivered: boolean
      warning?: string
    }
  /** The host refused before starting anything; `message` is the host's own, untranslated. */
  | { kind: 'failed'; message: string }
  /** The agent may be running; the caller must not launch again on its own. */
  | { kind: 'unknown' }

async function resolveLaunchTarget(worktreeId: string): Promise<RuntimeClientTarget | null> {
  const environmentId = getRuntimeEnvironmentIdForWorktree(useAppStore.getState(), worktreeId)
  if (environmentId && isWebRuntimeSessionActive(environmentId)) {
    for (const capability of REQUIRED_HOST_CAPABILITIES) {
      if (!(await runtimeEnvironmentSupportsCapability(environmentId, capability))) {
        return null
      }
    }
    return { kind: 'environment', environmentId }
  }
  // Why: an unanswered probe is not evidence the host lacks it; the older path stays safe then.
  const local = await ensureLocalRuntimeCapabilities()
  return local && REQUIRED_HOST_CAPABILITIES.every((capability) => local.includes(capability))
    ? { kind: 'local' }
    : null
}

function launchViewOptions(args: SourceControlAgentLaunchArgs) {
  const store = useAppStore.getState()
  const options = {
    agent: args.agent,
    promptDelivery: 'submit-after-ready' as const,
    launchDraftText: args.prompt,
    nativeChatTranscriptIsLocalReadable: isNativeChatTranscriptLocalReadable(
      getConnectionIdFromState(store, args.worktreeId)
    )
  }
  return {
    viewMode: initialAgentTabViewModeProps(store.settings, options).viewMode,
    sessionOptions: resolveInitialNativeChatSessionOptions(store.settings, options)
  }
}

/** The workspace's focused group, read here so no button can name a wrong one; the tab joins it. */
function launchTargetGroupId(worktreeId: string): string | undefined {
  return useAppStore.getState().activeGroupIdByWorktree[worktreeId]
}

async function sendReplayingAmbiguousLaunch(
  target: RuntimeClientTarget,
  params: Record<string, unknown>
): Promise<{ result: unknown } | { refusal: RuntimeRpcCallError; replayed: boolean } | null> {
  for (let attempt = 0; attempt < MAX_LAUNCH_ATTEMPTS; attempt += 1) {
    try {
      const result = await callRuntimeRpc<unknown>(target, 'agent.launchReplay', params, {
        timeoutMs: PROMPTED_AGENT_LAUNCH_TIMEOUT_MS
      })
      return { result }
    } catch (error) {
      if (error instanceof RuntimeRpcCallError) {
        // A paired host's timeout or lost connection arrives as an error reply, yet the launch may
        // have run: replay it, since a "failed" the user retries could start a second agent.
        if (!isRecoverableRemoteRuntimeConnectionError(error)) {
          return { refusal: error, replayed: attempt > 0 }
        }
      } else if (!isAmbiguousCreateFailure(error)) {
        throw error
      }
    }
  }
  return null
}

export async function launchSourceControlAgent(
  args: SourceControlAgentLaunchArgs
): Promise<SourceControlAgentLaunchResult> {
  const trimmedPrompt = args.prompt.trim()
  const groupId = launchTargetGroupId(args.worktreeId)
  let target: RuntimeClientTarget | null
  try {
    target = await resolveLaunchTarget(args.worktreeId)
  } catch (error) {
    // An unreachable paired host fails its capability probe before anything is sent.
    return { kind: 'failed', message: error instanceof Error ? error.message : String(error) }
  }
  if (!target) {
    return { kind: 'unsupported' }
  }
  const tabId = createBrowserUuid()
  const leafId = createBrowserUuid()
  const { viewMode, sessionOptions } = launchViewOptions({ ...args, prompt: trimmedPrompt })
  let accepted = false
  const accept = (): void => {
    if (!accepted) {
      accepted = true
      args.onLaunchAccepted?.()
    }
  }
  const sessionId = isAgentSessionHandleProvider(args.agent)
    ? createStructuredAgentSessionId(args.agent, createBrowserUuid)
    : undefined
  let revealSeen = false
  const placement = placeAgentLaunchTab({
    target,
    worktreeId: args.worktreeId,
    ...(groupId ? { groupId } : {}),
    tabId,
    leafId,
    ...(sessionId ? { sessionId } : {}),
    onRevealed: (reveal) => {
      revealSeen = true
      accept()
      if (!reveal.inView) {
        showAgentLaunchStartedElsewhereNotice({
          agent: args.agent,
          worktreeId: args.worktreeId,
          tab: { tabId: reveal.tabId, leafId: reveal.leafId }
        })
      }
    }
  })
  let launched: AgentLaunchResult | null = null
  const params = {
    agent: args.agent,
    operationId: createAgentSessionOperationId(),
    target: { kind: 'existing', worktree: `id:${args.worktreeId}` },
    prompt: { text: trimmedPrompt, delivery: 'submit' },
    ...(args.agentArgs !== undefined ? { agentArgs: args.agentArgs } : {}),
    ...(sessionOptions ? { sessionOptions } : {}),
    launchSource: args.launchSource,
    paneKey: makePaneKey(tabId, leafId),
    // Why: omission means terminal locally, but would let a paired host apply its own default.
    ...(viewMode || target.kind === 'environment' ? { viewMode: viewMode ?? 'terminal' } : {}),
    ...(sessionId ? { sessionId } : {})
  }
  try {
    // After the hold: a workspace reveal reconciles tabs, which drops an unheld empty split.
    if (args.beforeLaunch?.() === false) {
      return { kind: 'aborted' }
    }
    const sent = await sendReplayingAmbiguousLaunch(target, params)
    if (!sent) {
      return { kind: 'unknown' }
    }
    if ('refusal' in sent) {
      return refusalResult(sent.refusal, sent.replayed)
    }
    if (!isAgentLaunchResult(sent.result)) {
      return { kind: 'unknown' }
    }
    launched = sent.result
    // A chat, a reused pane or a missed reveal never reads the reservation; the reply still means
    // the surface exists.
    accept()
    // Why: those surfaces never switch workspaces; a user who left is told where the agent is.
    if (!revealSeen && !isWorkspaceInTerminalView(args.worktreeId)) {
      showAgentLaunchStartedElsewhereNotice({ agent: args.agent, worktreeId: args.worktreeId })
    }
    return launchedResult(sent.result)
  } catch (error) {
    return { kind: 'failed', message: error instanceof Error ? error.message : String(error) }
  } finally {
    placement.settle(launched)
  }
}

function refusalResult(
  refusal: RuntimeRpcCallError,
  replayed: boolean
): SourceControlAgentLaunchResult {
  switch (classifyAgentLaunchReplayRefusal(refusal, replayed)) {
    case 'unsupported':
      return { kind: 'unsupported' }
    case 'unknown':
      return { kind: 'unknown' }
    case 'failed':
      return { kind: 'failed', message: refusal.message }
  }
}

function launchedResult(result: AgentLaunchResult): SourceControlAgentLaunchResult {
  return {
    kind: 'launched',
    // A prompted launch whose receipt is missing under-claims: the caller keeps the text.
    promptDelivered: result.prompt !== undefined && result.prompt.outcome !== 'not-delivered',
    ...(result.warning ? { warning: result.warning } : {})
  }
}

export type SettledSourceControlAgentLaunch = {
  /** The agent is running. */
  started: boolean
  promptDelivered: boolean
  /** The user was already told what went wrong, so the caller adds no toast of its own. */
  failureNotified: boolean
}

/** Tells the user what a hosted launch did; `unsupported` is the caller's to handle. */
export function settleSourceControlAgentLaunch(
  result: Exclude<SourceControlAgentLaunchResult, { kind: 'unsupported' }>,
  args: { agent: TuiAgent; prompt: string }
): SettledSourceControlAgentLaunch {
  if (result.kind === 'aborted') {
    // The caller's `beforeLaunch` declined and has already said why.
    return { started: false, promptDelivered: false, failureNotified: true }
  }
  if (result.kind === 'failed') {
    toast.error(
      translate('auto.lib.source.control.agent.launch.failed', "Couldn't start the agent."),
      { description: result.message }
    )
    return { started: false, promptDelivered: false, failureNotified: true }
  }
  if (result.kind === 'unknown') {
    toast.error(
      translate(
        'auto.lib.source.control.agent.launch.unconfirmed',
        "Couldn't confirm the agent started. Check the workspace before trying again."
      )
    )
    return { started: false, promptDelivered: false, failureNotified: true }
  }
  if (result.warning) {
    toast.warning(result.warning)
  }
  if (!result.promptDelivered) {
    showAgentLaunchPromptNotDeliveredNotice({ agent: args.agent, prompt: args.prompt })
  }
  return {
    started: true,
    promptDelivered: result.promptDelivered,
    failureNotified: !result.promptDelivered
  }
}
