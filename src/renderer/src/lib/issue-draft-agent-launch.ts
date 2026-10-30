import { toast } from 'sonner'
import { ensureAgentLaunchPreferences } from '@/components/settings/use-host-agent-launch-preferences'
import { translate } from '@/i18n/i18n'
import { buildAgentLaunchRouteInput, worktreeLaunchWorkspace } from '@/lib/agent-launch-route-input'
import { structuredAgentLaunchSupported } from '@/lib/agent-launch-routing'
import { newAgentLaunchRequestId } from '@/lib/agent-launch-request-id'
import { ensureDetectedAgentsForWorktree } from '@/lib/agent-detection-target-inventory'
import { planAgentSessionLaunch } from '@/lib/agent-session-launch-plan'
import { beginStructuredAgentSessionProvisionalLaunch } from '@/lib/agent-session/structured-agent-session-provisional-tab'
import { useAppStore } from '@/store'
import { pickTuiAgent } from '../../../shared/tui-agent-selection'
import { structuredAgentSessionTabId } from '../../../shared/structured-agent-session-projection'
import {
  AgentLaunchChoiceCancelled,
  acquireAgentLaunchChoices
} from './host-chat-program-acquisition'

export type IssueDraftChat = { worktreeId: string; tabId: string; sessionId: string }

/** The repo's primary checkout, where issue drafting runs without creating a worktree. */
export function findPrimaryWorktreeId(repoId: string): string | null {
  return (
    useAppStore
      .getState()
      .allWorktrees()
      .find((worktree) => worktree.repoId === repoId && worktree.isMainWorktree)?.id ?? null
  )
}

/** Starts a background chat with the default agent in the repo's primary checkout. */
export async function startIssueDraftChat(args: {
  repoId: string
  prompt: string
}): Promise<IssueDraftChat | null> {
  try {
    return await startInPrimaryWorktree(args)
  } catch (error) {
    if (
      error instanceof AgentLaunchChoiceCancelled ||
      (error instanceof DOMException && error.name === 'AbortError')
    ) {
      return null
    }
    throw error
  }
}

async function startInPrimaryWorktree({
  repoId,
  prompt
}: {
  repoId: string
  prompt: string
}): Promise<IssueDraftChat | null> {
  const worktreeId = findPrimaryWorktreeId(repoId)
  if (!worktreeId) {
    toast.error(
      translate(
        'auto.lib.issue.draft.agent.launch.noPrimaryWorktree',
        'This project has no primary checkout to run the agent in.'
      )
    )
    return null
  }
  const workspace = worktreeLaunchWorkspace(worktreeId)
  const [choices, preferences] = await Promise.all([
    acquireAgentLaunchChoices(workspace, () =>
      ensureDetectedAgentsForWorktree(useAppStore.getState(), worktreeId)
    ),
    ensureAgentLaunchPreferences(useAppStore.getState(), workspace)
  ])
  const state = useAppStore.getState()
  // Why: the panel embeds a chat, so only agents the host can run as one qualify; the default wins when it can.
  const chatAgents = (choices.detected ?? []).filter((candidate) =>
    structuredAgentLaunchSupported(
      buildAgentLaunchRouteInput(state, { agent: candidate, workspace })
    )
  )
  const agent = pickTuiAgent(
    state.settings?.defaultTuiAgent,
    chatAgents,
    preferences.disabledTuiAgents
  )
  if (!agent) {
    toast.error(
      translate(
        'auto.lib.issue.draft.agent.launch.noAgent',
        'No enabled agent that can run as a chat was detected for this project.'
      )
    )
    return null
  }
  // Why chat: the panel embeds the conversation, which a terminal TUI cannot provide.
  const plan = planAgentSessionLaunch(useAppStore.getState(), {
    requestId: newAgentLaunchRequestId(),
    agent,
    requestedSurface: 'chat',
    workspace,
    prompt,
    promptDelivery: 'auto-submit'
  })
  // Why activate false: the conversation shows in the Tasks panel; the workspace stays where it was.
  const launch = beginStructuredAgentSessionProvisionalLaunch({
    plan,
    hooks: {},
    target: { worktreeId },
    activate: false
  })
  if (!launch) {
    toast.error(translate('auto.lib.issue.draft.agent.launch.failed', 'Could not start the agent.'))
    return null
  }
  const settlement = await launch.settlement
  if (settlement.kind !== 'structured') {
    if (settlement.kind === 'terminal') {
      toast.error(
        translate(
          'auto.lib.issue.draft.agent.launch.noChat',
          'This agent cannot run as a chat here, so it opened in a terminal in the primary checkout.'
        )
      )
    } else if (settlement.kind === 'failed' && !settlement.notified) {
      toast.error(
        translate('auto.lib.issue.draft.agent.launch.failed', 'Could not start the agent.')
      )
    }
    return null
  }
  return {
    worktreeId,
    tabId: launch.tab?.id ?? structuredAgentSessionTabId(settlement.sessionId),
    sessionId: settlement.sessionId
  }
}
