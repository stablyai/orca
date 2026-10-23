import { listAutomationRunsForTarget } from '@/components/automations/automation-host-client'
import { submitPromptToAgentPty } from '@/lib/agent-paste-draft'
import { sendMessageToAgent } from '@/lib/agent-message-send'
import { workspaceKindForWorktreeId } from '@/lib/agent-launch-route-input'
import { observeExistingAutomationSession } from '@/lib/automation-session-observer'
import {
  findReusableAutomationSession,
  type ReusableAutomationSession
} from '@/lib/automation-session-reuse'
import { useAppStore } from '@/store'
import { hasExtraAgentArgs } from '../../../shared/automation-extra-agent-args'
import { parseExecutionHostId } from '../../../shared/execution-host'
import { isNativeChatDefaultFor } from '../../../shared/structured-native-chat-launch-route'
import {
  structuredAgentSessionPaneKey,
  structuredAgentSessionTabId
} from '../../../shared/structured-agent-session-projection'
import type {
  Automation,
  AutomationDispatchResult,
  AutomationPrecheckResult,
  AutomationRun
} from '../../../shared/automations-types'
import type { Worktree } from '../../../shared/worktree/types'
import type { createAutomationDispatchCompletion } from './automation-dispatch-completion'

const activeReuseDispatchTabIds = new Set<string>()

function acquireReuseDispatchTab(tabId: string): (() => void) | null {
  if (activeReuseDispatchTabIds.has(tabId)) {
    return null
  }
  activeReuseDispatchTabIds.add(tabId)
  return () => activeReuseDispatchTabIds.delete(tabId)
}

export type StructuredAutomationLaunchResult = {
  chatSessionId: string
  tabId: string
  paneKey: string
}

export async function reuseStructuredAutomationSession(args: {
  worktreeId: string
  tabId: string
  chatSessionId: string
  paneKey: string
  prompt: string
}): Promise<boolean> {
  const sent = await sendMessageToAgent({
    worktreeId: args.worktreeId,
    target: { kind: 'structured-session', sessionId: args.chatSessionId },
    prompt: args.prompt
  })
  return sent.status === 'sent'
}

export async function launchStructuredAutomationSession(args: {
  automation: Automation
  run: Pick<AutomationRun, 'id'>
  worktreeId: string
}): Promise<StructuredAutomationLaunchResult | null> {
  const { automation, run, worktreeId } = args
  if (hasExtraAgentArgs(automation.extraAgentArgs)) {
    return null
  }
  const store = useAppStore.getState()
  if (!isNativeChatDefaultFor(store.settings, automation.agentId)) {
    return null
  }
  const [{ planAgentSessionLaunch }, { beginStructuredAgentSessionProvisionalLaunch }] =
    await Promise.all([
      import('@/lib/agent-session-launch-plan'),
      import('@/lib/structured-agent-session-provisional-tab')
    ])
  const executionHostId = parseExecutionHostId(automation.runContext?.hostId)?.id
  const plan = planAgentSessionLaunch(store, {
    requestId: run.id,
    agent: automation.agentId,
    ...(executionHostId ? { selectedExecutionHostId: executionHostId } : {}),
    workspace: {
      kind: workspaceKindForWorktreeId(worktreeId),
      worktreeId,
      ...(executionHostId ? { executionHostId } : {})
    },
    prompt: automation.prompt,
    promptDelivery: 'auto-submit',
    promptKeptByCaller: true
  })
  if (plan.route !== 'structured-native-chat') {
    return null
  }
  const launch = beginStructuredAgentSessionProvisionalLaunch({
    plan,
    hooks: { activate: false },
    target: {
      worktreeId,
      ...(executionHostId ? { executionHostId } : {})
    },
    activate: false,
    onHostDeclined: () => ({ opened: false })
  })
  if (!launch) {
    return null
  }
  const settlement = await launch.settlement
  if (settlement.kind !== 'structured') {
    return null
  }
  if (settlement.promptDeliveryResult) {
    const delivery = await settlement.promptDeliveryResult
    if (!delivery.delivered && !delivery.unconfirmed) {
      throw new Error('Automation prompt could not be delivered to the structured chat session.')
    }
  }
  const chatSessionId = settlement.sessionId
  const tabId = launch.tab?.id ?? structuredAgentSessionTabId(chatSessionId)
  const paneKey = structuredAgentSessionPaneKey(tabId, chatSessionId)
  return {
    chatSessionId,
    tabId,
    paneKey
  }
}

export async function tryDispatchReusableAutomationSession(args: {
  automation: Automation
  run: AutomationRun
  worktree: Worktree
  precheckResult: AutomationPrecheckResult | null
  completion: ReturnType<typeof createAutomationDispatchCompletion>
  markDispatchResult: (result: AutomationDispatchResult) => Promise<void>
}): Promise<boolean> {
  const { automation, run, worktree, precheckResult, completion, markDispatchResult } = args
  const reusableSession = findReusableAutomationSession({
    automationId: automation.id,
    agentId: automation.agentId,
    worktreeId: worktree.id,
    currentRunId: run.id,
    // Why: the dispatch loop only ever executes for the desktop authority,
    // so its history read addresses the local runtime explicitly.
    runs: await listAutomationRunsForTarget({ kind: 'local' }, automation.id),
    state: useAppStore.getState()
  })
  if (!reusableSession) {
    return false
  }
  const releaseTab = acquireReuseDispatchTab(reusableSession.tabId)
  if (!releaseTab) {
    return false
  }
  completion.setReuseDispatchTabRelease(releaseTab)
  if (reusableSession.kind === 'structured') {
    return dispatchReusableStructuredSession(reusableSession, args)
  }
  try {
    const submitted = await submitPromptToAgentPty({
      tabId: reusableSession.tabId,
      ptyId: reusableSession.ptyId,
      content: automation.prompt
    })
    if (!submitted) {
      completion.cleanupRunObservers()
      return false
    }
    let reuseSawWorking = false
    const handleReusableAgentStatus = (payload: { state: string }): void => {
      if (payload.state === 'working') {
        reuseSawWorking = true
        return
      }
      if (payload.state === 'done' && reuseSawWorking) {
        completion.handleAgentDone()
      }
    }
    const reuseCompletionStartedAt = Date.now()
    completion.setSessionObserver(
      await observeExistingAutomationSession({
        ptyId: reusableSession.ptyId,
        paneKey: reusableSession.paneKey,
        runId: run.id,
        onData: completion.appendOutput,
        onAgentStatus: (payload) => {
          completion.captureAssistantMessage(payload.lastAssistantMessage)
          handleReusableAgentStatus(payload)
        },
        onExit: completion.handleExit
      })
    )
    completion.observeAgentStatus(reusableSession.paneKey, reuseCompletionStartedAt, {
      requireWorkingAfterStart: true
    })
    await markDispatchResult({
      runId: run.id,
      status: 'dispatched',
      workspaceId: worktree.id,
      workspaceDisplayName: worktree.displayName,
      terminalSessionId: reusableSession.tabId,
      terminalPaneKey: reusableSession.paneKey,
      terminalPtyId: reusableSession.ptyId,
      precheckResult,
      error: null
    })
    await completion.settlePendingAfterDispatch()
    return true
  } catch (error) {
    completion.cleanupRunObservers()
    throw error
  }
}

async function dispatchReusableStructuredSession(
  reusableSession: Extract<ReusableAutomationSession, { kind: 'structured' }>,
  args: {
    automation: Automation
    run: AutomationRun
    worktree: Worktree
    precheckResult: AutomationPrecheckResult | null
    completion: ReturnType<typeof createAutomationDispatchCompletion>
    markDispatchResult: (result: AutomationDispatchResult) => Promise<void>
  }
): Promise<boolean> {
  const { automation, run, worktree, precheckResult, completion, markDispatchResult } = args
  try {
    const reuseCompletionStartedAt = Date.now()
    const submitted = await reuseStructuredAutomationSession({
      worktreeId: worktree.id,
      tabId: reusableSession.tabId,
      chatSessionId: reusableSession.chatSessionId,
      paneKey: reusableSession.paneKey,
      prompt: automation.prompt
    })
    if (!submitted) {
      completion.cleanupRunObservers()
      return false
    }
    completion.observeAgentStatus(reusableSession.paneKey, reuseCompletionStartedAt, {
      requireWorkingAfterStart: true
    })
    await markDispatchResult({
      runId: run.id,
      status: 'dispatched',
      workspaceId: worktree.id,
      workspaceDisplayName: worktree.displayName,
      sessionKind: 'structured',
      chatSessionId: reusableSession.chatSessionId,
      terminalSessionId: reusableSession.tabId,
      terminalPaneKey: reusableSession.paneKey,
      terminalPtyId: null,
      precheckResult,
      error: null
    })
    await completion.settlePendingAfterDispatch()
    return true
  } catch (error) {
    completion.cleanupRunObservers()
    throw error
  }
}
