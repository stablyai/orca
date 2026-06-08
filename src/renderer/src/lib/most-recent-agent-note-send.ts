import { toast } from 'sonner'
import { useAppStore } from '@/store'
import { agentTypeToIconAgent, formatAgentTypeLabel } from './agent-status'
import { sendBracketedPasteToRunningAgent } from './agent-paste-draft'
import {
  deriveRunningAgentSendTargets,
  resolveRunningAgentSendTarget,
  type RunningAgentSendTarget
} from './running-agent-targets'
import { track } from './telemetry'
import { tuiAgentToAgentKind } from '../../../shared/agent-kind'
import type { LaunchSource } from '../../../shared/telemetry-events'
import type { AppState } from '@/store/types'

const AGENT_SEND_WORKING_WAIT_TIMEOUT_MS = 10_000
const AGENT_SEND_WORKING_WAIT_INTERVAL_MS = 250

type MostRecentAgentTargetState = Pick<
  AppState,
  'agentStatusByPaneKey' | 'tabsByWorktree' | 'terminalLayoutsByTabId'
>

type AgentTargetReadyResult =
  | { target: RunningAgentSendTarget; error?: never }
  | { target?: never; error: string }

export function selectMostRecentRunningAgentSendTarget(
  state: MostRecentAgentTargetState,
  worktreeId: string
): RunningAgentSendTarget | null {
  const targets = deriveRunningAgentSendTargets(state, worktreeId).filter(
    (target) =>
      target.ptyId && (target.status === 'eligible' || target.disabledReason === 'Agent is working')
  )
  if (targets.length === 0) {
    return null
  }

  return [...targets].sort((a, b) => {
    const recencyDelta = getTargetRecency(b) - getTargetRecency(a)
    if (recencyDelta !== 0) {
      return recencyDelta
    }
    return a.paneKey.localeCompare(b.paneKey)
  })[0]
}

export async function sendNotesToMostRecentAgentSession(args: {
  worktreeId: string
  prompt: string
  launchSource: LaunchSource
  onPromptDelivered?: () => void
}): Promise<boolean> {
  const target = selectMostRecentRunningAgentSendTarget(useAppStore.getState(), args.worktreeId)
  if (!target) {
    toast.error('No agent session available', {
      description: 'Start an agent in this workspace to send notes.'
    })
    return false
  }

  const label = formatAgentTypeLabel(target.entry.agentType)
  const readyTarget = await waitForAgentTargetReady(args.worktreeId, target.paneKey)
  if (!readyTarget.target) {
    toast.error(`Couldn't send to ${label}`, { description: readyTarget.error })
    return false
  }

  const delivered = await sendBracketedPasteToRunningAgent({
    ptyId: readyTarget.target.ptyId!,
    content: args.prompt
  }).catch(() => false)

  if (!delivered) {
    toast.error(`Couldn't send to ${label}`, { description: 'Terminal is no longer available' })
    return false
  }

  args.onPromptDelivered?.()
  track('agent_prompt_sent', {
    agent_kind: agentKindForTarget(readyTarget.target.entry.agentType),
    launch_source: args.launchSource,
    request_kind: 'followup'
  })
  toast.success(`Sent to ${label}`)
  return true
}

function getTargetRecency(target: RunningAgentSendTarget): number {
  // Why: "most recent session" should follow the last hook activity when
  // available, while still being deterministic for quiet/restored sessions.
  return Math.max(
    target.entry.updatedAt,
    target.entry.stateStartedAt,
    target.entry.stateHistory[0]?.startedAt ?? 0,
    target.tab.createdAt
  )
}

async function waitForAgentTargetReady(
  worktreeId: string,
  paneKey: string
): Promise<AgentTargetReadyResult> {
  const deadline = Date.now() + AGENT_SEND_WORKING_WAIT_TIMEOUT_MS

  while (true) {
    const target = resolveRunningAgentSendTarget(useAppStore.getState(), worktreeId, paneKey)
    if (!target || !target.ptyId) {
      return { error: 'Terminal is no longer available' }
    }
    if (target.status !== 'eligible' && target.disabledReason !== 'Agent is working') {
      return { error: target.disabledReason ?? 'Agent is not available' }
    }
    if (target.entry.state !== 'working') {
      return { target }
    }
    if (Date.now() >= deadline) {
      return { error: 'Agent is still working' }
    }

    await new Promise((resolve) =>
      globalThis.setTimeout(resolve, AGENT_SEND_WORKING_WAIT_INTERVAL_MS)
    )
  }
}

function agentKindForTarget(agentType: Parameters<typeof agentTypeToIconAgent>[0]) {
  const tuiAgent = agentTypeToIconAgent(agentType)
  return tuiAgent ? tuiAgentToAgentKind(tuiAgent) : 'other'
}
