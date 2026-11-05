import { useAppStore } from '@/store'
import { ensureAgentLaunchPreferences } from '@/runtime/agent-launch-settings/use-host-agent-launch-preferences'
import type { AgentLaunchPreferences } from '@/runtime/agent-launch-settings/host-agent-launch-preferences-resource'
import {
  AgentLaunchChoiceCancelled,
  acquireAgentLaunchChoices
} from '@/lib/host-chat-program-acquisition'
import { ensureDetectedAgentsForTarget } from '@/lib/agent-detection-target-inventory'
import { resolveDefaultAgentForWorkspace } from '@/lib/agent-tab-shortcuts'
import { awaitStructuredRouteHostAnswer } from '@/lib/agent-session-launch-plan'
import type { ProspectiveWorkspace } from '@/lib/agent-launch-route-input'
import type { AgentDetectionTarget } from '@/hooks/useDetectedAgents'
import { parseExecutionHostId } from '../../../../shared/execution-host'
import type { TuiAgent } from '../../../../shared/agent-launch/catalog/tui-agent'

export type DirectCreateAgent = {
  agent: TuiAgent | null
  preferences: AgentLaunchPreferences
}

/** The dialog's detection target for a host: a paired server, then SSH, then this machine. */
export function directCreateDetectionTarget(executionHostId: string): AgentDetectionTarget {
  const host = parseExecutionHostId(executionHostId)
  if (host?.kind === 'runtime') {
    return { kind: 'runtime', environmentId: host.environmentId }
  }
  return host?.kind === 'ssh' ? { kind: 'ssh', connectionId: host.targetId } : { kind: 'local' }
}

/** The agent the new-workspace dialog would preselect, read from the target host at click time. */
export async function resolveDirectCreateAgent(
  workspace: ProspectiveWorkspace,
  detectionTarget: AgentDetectionTarget
): Promise<DirectCreateAgent> {
  // One snapshot per click, so the agent picked and the profile it launches with agree.
  const preferences = await ensureAgentLaunchPreferences(useAppStore.getState(), workspace)
  if (preferences.defaultTuiAgent === 'blank') {
    return { agent: null, preferences }
  }
  // Bounded: an unanswered host must not swallow the click.
  const { detected } = await acquireAgentLaunchChoices(
    workspace,
    () => ensureDetectedAgentsForTarget(useAppStore.getState(), detectionTarget),
    undefined,
    true
  ).catch((error: unknown) => {
    // An owner change cancels the click; it must not create on the replacement host.
    if (error instanceof AgentLaunchChoiceCancelled) {
      throw error
    }
    return { detected: null }
  })
  const pick = (): TuiAgent | null =>
    resolveDefaultAgentForWorkspace({
      defaultTuiAgent: preferences.defaultTuiAgent,
      detectedAgentIds: detected,
      disabledTuiAgents: preferences.disabledTuiAgents,
      chatIn: { store: useAppStore.getState(), workspace }
    })
  const agent = pick()
  if (!agent) {
    return { agent: null, preferences }
  }
  // Same 3s host answer the dialog-less task launch waits for before it picks Chat or Terminal.
  await awaitStructuredRouteHostAnswer(useAppStore.getState(), { agent, workspace }, 3000)
  return { agent: pick(), preferences }
}

/** Owner change or abort while resolving: the click is dropped, as the direct task launch does. */
export function isDirectCreateCancelled(error: unknown): boolean {
  return (
    error instanceof AgentLaunchChoiceCancelled ||
    (error instanceof DOMException && error.name === 'AbortError')
  )
}
