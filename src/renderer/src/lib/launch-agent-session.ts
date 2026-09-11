import type { StructuredAgentSessionResumeSource } from '../../../shared/structured-agent-session-create'
import type { LaunchSource } from '../../../shared/telemetry-events'
import type { TuiAgent } from '../../../shared/tui-agent'
import type { SessionOptionValue } from '../../../shared/native-chat-session-options'
import { workspaceKindForWorktreeId, type AgentLaunchRouteStore } from './agent-launch-route-input'
import { planAgentSessionLaunch } from './agent-session-launch-plan'
import type { NativeChatLaunchPromptDelivery } from './native-chat-initial-view-mode'
import { activateStructuredAgentSessionById } from './structured-agent-session-tab-activation'
import type { StructuredPromptDeliveryResult } from './structured-agent-session-launch-prompt'
import { closeStructuredAgentSession } from '@/runtime/structured-agent-session-close'
import { callRuntimeRpc } from '@/runtime/runtime-rpc-client'
import { toRuntimeWorktreeSelector } from '@/runtime/runtime-worktree-selector'
import { useAppStore } from '@/store'
import { activateAndRevealWorkspace } from './worktree-activation'
import { launchTerminalSession } from './launch-agent-session-terminal'

export type AgentSessionLaunchRequest = {
  agent: TuiAgent
  workspaceId: string
  prompt?: string
  promptDelivery?: NativeChatLaunchPromptDelivery
  tuiCustomization?: { cwd?: string | null; agentArgs?: string | null }
  launchPlatform?: NodeJS.Platform
  initialSessionOptions?: Readonly<Record<string, SessionOptionValue>>
  resumeFrom?: StructuredAgentSessionResumeSource
  onPromptDelivered?: () => void
  visibility: 'reveal' | 'background'
  signal?: AbortSignal
  launchSource: LaunchSource
  terminalFallback?: boolean
  pendingFirstAgentMessageRename?: boolean
  reconcileUnknownLaunch?: boolean
}

export type AgentSessionLaunchOutcome =
  | {
      kind: 'structured'
      sessionId: string
      tabId: string
      promptDeliveryResult?: Promise<StructuredPromptDeliveryResult>
    }
  | {
      kind: 'terminal'
      tabId: string | null
      viaRefusal: boolean
      promptDeliveryResult?: Promise<StructuredPromptDeliveryResult>
    }
  | { kind: 'cancelled'; surface?: { tabId: string | null } }
  | { kind: 'visibility-unknown'; sessionId: string }
  | { kind: 'failed'; error: unknown }

export type TerminalLaunchResult = {
  tabId: string | null
  promptDeliveryResult?: Promise<StructuredPromptDeliveryResult>
  error?: unknown
}

async function retireCancelledStructuredSession(
  workspaceId: string,
  sessionId: string
): Promise<void> {
  const target = { kind: 'local' } as const
  await closeStructuredAgentSession(target, sessionId).catch(() => undefined)
  await callRuntimeRpc(target, 'session.tabs.close', {
    worktree: toRuntimeWorktreeSelector(workspaceId),
    tabId: `agent-session:${sessionId}`,
    reason: 'user'
  }).catch(() => undefined)
}

export async function launchAgentSession(
  store: AgentLaunchRouteStore,
  request: AgentSessionLaunchRequest
): Promise<AgentSessionLaunchOutcome> {
  const plan = planAgentSessionLaunch(store, {
    agent: request.agent,
    workspace: {
      kind: workspaceKindForWorktreeId(request.workspaceId),
      worktreeId: request.workspaceId
    },
    ...(request.prompt !== undefined ? { prompt: request.prompt } : {}),
    ...(request.promptDelivery ? { promptDelivery: request.promptDelivery } : {}),
    ...(request.tuiCustomization ? { tuiCustomization: request.tuiCustomization } : {}),
    ...(request.initialSessionOptions
      ? { initialSessionOptions: request.initialSessionOptions }
      : {}),
    ...(request.resumeFrom ? { resumeFrom: request.resumeFrom } : {}),
    ...(request.onPromptDelivered ? { onPromptDelivered: request.onPromptDelivered } : {}),
    ...(request.terminalFallback === false ? { notifyFailure: false } : {}),
    ...(request.reconcileUnknownLaunch !== undefined
      ? { reconcileUnknownLaunch: request.reconcileUnknownLaunch }
      : {})
  })
  if (plan.route !== 'structured-native-chat') {
    try {
      const terminal = await launchTerminalSession(request)
      return terminal.error
        ? { kind: 'failed', error: terminal.error }
        : {
            kind: 'terminal',
            tabId: terminal.tabId,
            viaRefusal: false,
            ...(terminal.promptDeliveryResult
              ? { promptDeliveryResult: terminal.promptDeliveryResult }
              : {})
          }
    } catch (error) {
      return { kind: 'failed', error }
    }
  }

  let structuredTabId: string | null = null
  let viaRefusal = false
  let fallback: TerminalLaunchResult | null = null
  try {
    const settlement = await plan.launch({
      ...(request.terminalFallback === false
        ? {}
        : {
            legacyFallback: async () => {
              viaRefusal = true
              fallback = await launchTerminalSession(request)
              return {
                primaryTabId: fallback.tabId,
                ...(fallback.promptDeliveryResult
                  ? { promptDeliveryResult: fallback.promptDeliveryResult }
                  : {})
              }
            }
          }),
      ...(request.visibility === 'reveal'
        ? {
            onStructuredReady: (sessionId: string) => {
              activateAndRevealWorkspace(request.workspaceId, {
                providesInitialSurface: true
              })
              activateStructuredAgentSessionById({ worktreeId: request.workspaceId, sessionId })
              structuredTabId =
                useAppStore
                  .getState()
                  .unifiedTabsByWorktree[request.workspaceId]?.find(
                    (tab) => tab.contentType === 'agent-session' && tab.entityId === sessionId
                  )?.id ?? `agent-session:${sessionId}`
            }
          }
        : {}),
      ...(request.signal ? { signal: request.signal } : {})
    })
    if (!settlement) {
      return { kind: 'failed', error: new Error('Structured launch did not settle.') }
    }
    switch (settlement.kind) {
      case 'structured':
        return {
          kind: 'structured',
          sessionId: settlement.sessionId,
          tabId: structuredTabId ?? `agent-session:${settlement.sessionId}`,
          ...(settlement.promptDeliveryResult
            ? { promptDeliveryResult: settlement.promptDeliveryResult }
            : {})
        }
      case 'refused-then-legacy':
        return {
          kind: 'terminal',
          tabId: settlement.primaryTabId,
          viaRefusal: true,
          ...(settlement.promptDeliveryResult
            ? { promptDeliveryResult: settlement.promptDeliveryResult }
            : {})
        }
      case 'cancelled':
        if (!viaRefusal) {
          await retireCancelledStructuredSession(request.workspaceId, settlement.sessionId)
        }
        const fallbackState = fallback as TerminalLaunchResult | null
        const fallbackTabId = fallbackState?.tabId ?? null
        const fallbackRan = fallbackState !== null
        return {
          kind: 'cancelled',
          ...(settlement.fallback
            ? { surface: { tabId: settlement.fallback.primaryTabId } }
            : fallbackRan
              ? { surface: { tabId: fallbackTabId } }
              : {})
        }
      case 'visibility-unknown':
        return settlement
      case 'failed':
        return settlement
    }
  } catch (error) {
    return { kind: 'failed', error }
  }
}
