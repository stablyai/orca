import { useAppStore } from '@/store'
import { translate } from '@/i18n/i18n'
import { getAgentLabel } from '@/lib/agent-catalog'
import { ensureAgentLaunchPreferences } from '@/runtime/agent-launch-settings/use-host-agent-launch-preferences'
import type { AgentLaunchPreferences } from '@/runtime/agent-launch-settings/host-agent-launch-preferences-resource'
import {
  getRuntimeEnvironmentRevision,
  onRuntimeEnvironmentsRetired
} from '@/runtime/runtime-environment-revision'
import { ipcOrRuntimeTargetForHostId } from '@/runtime/runtime-client-target'
import {
  AgentLaunchChoiceCancelled,
  acquireAgentLaunchChoices
} from '@/lib/host-chat-program-acquisition'
import {
  ensureDetectedAgentsForTarget,
  loadProjectLaunchContext
} from '@/lib/agent-detection-target-inventory'
import { resolveDefaultAgentForWorkspace } from '@/lib/agent-tab-shortcuts'
import { awaitStructuredRouteHostAnswer } from '@/lib/agent-session-launch-plan'
import type { ProspectiveWorkspace } from '@/lib/agent-launch-route-input'
import type { ExecutionHostPlatformFact } from '@/lib/execution-host-facts'
import type { AgentDetectionTarget } from '@/hooks/useDetectedAgents'
import { completeAgentSessionsParallelStep } from '../contextual-tours/workspace-creation-tour-handoff'
import { parseExecutionHostId, type ExecutionHostId } from '../../../../shared/execution-host'
import { isTuiAgent } from '../../../../shared/agent-launch/catalog/tui-agent-config'
import type { TuiAgent } from '../../../../shared/agent-launch/catalog/tui-agent'

export type DirectCreateAgent = {
  agent: TuiAgent | null
  preferences: AgentLaunchPreferences
}

type DetectAgents = () => Promise<readonly TuiAgent[] | null>

// A direct create replaces the composer, whose opening is what cleared the final + tip on every create entry point.
export function beginDirectFolderCreate(): void {
  completeAgentSessionsParallelStep()
  const state = useAppStore.getState()
  if (state.activeModal && state.activeModal !== 'none') {
    state.closeModal()
  }
}

/** The dialog's detection target for a host: a paired server, then SSH, then this machine. */
export function directCreateDetectionTarget(executionHostId: string): AgentDetectionTarget {
  const host = parseExecutionHostId(executionHostId)
  if (host?.kind === 'runtime') {
    return { kind: 'runtime', environmentId: host.environmentId }
  }
  return host?.kind === 'ssh' ? { kind: 'ssh', connectionId: host.targetId } : { kind: 'local' }
}

/** The project's own runtime (e.g. a server's WSL distro) can differ from its host's default list. */
export function detectFolderRepoAgents(repoId: string, executionHostId: ExecutionHostId) {
  return async (): Promise<readonly TuiAgent[] | null> => {
    const target = ipcOrRuntimeTargetForHostId(executionHostId)
    const context = target
      ? await loadProjectLaunchContext(target, repoId).catch(() => undefined)
      : undefined
    return context
      ? context.agents.filter(isTuiAgent)
      : ensureDetectedAgentsForTarget(
          useAppStore.getState(),
          directCreateDetectionTarget(executionHostId)
        )
  }
}

function runtimeOwnerOf(workspace: ProspectiveWorkspace): string | null {
  const host = parseExecutionHostId(workspace.executionHostId)
  return host?.kind === 'runtime' ? host.environmentId : null
}

/** The agent the new-workspace dialog would preselect, read from the target host at click time. */
export async function resolveDirectCreateAgent(
  workspace: ProspectiveWorkspace,
  detect: DetectAgents
): Promise<DirectCreateAgent> {
  // Any pairing change cancels the whole click, as each acquisition inside it already does;
  // the click gathered one snapshot and must not create with it on a re-paired server.
  const environmentId = runtimeOwnerOf(workspace)
  const revision = environmentId ? getRuntimeEnvironmentRevision(environmentId) : undefined
  let retired = false
  const stopRetirement = environmentId
    ? onRuntimeEnvironmentsRetired((ids) => {
        retired ||= ids.includes(environmentId)
      })
    : () => {}
  try {
    const result = await pickDirectCreateAgent(workspace, detect)
    if (environmentId && (retired || getRuntimeEnvironmentRevision(environmentId) !== revision)) {
      throw new AgentLaunchChoiceCancelled('Agent launch owner changed')
    }
    return result
  } finally {
    stopRetirement()
  }
}

async function pickDirectCreateAgent(
  workspace: ProspectiveWorkspace,
  detect: DetectAgents
): Promise<DirectCreateAgent> {
  // One snapshot per click, so the agent picked and the profile it launches with agree.
  const preferences = await ensureAgentLaunchPreferences(useAppStore.getState(), workspace)
  if (preferences.defaultTuiAgent === 'blank') {
    return { agent: null, preferences }
  }
  // Bounded: an unanswered host must not swallow the click.
  const { detected } = await acquireAgentLaunchChoices(workspace, detect, undefined, true).catch(
    (error: unknown) => {
      if (error instanceof AgentLaunchChoiceCancelled) {
        throw error
      }
      return { detected: null }
    }
  )
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

// A direct create refuses where the dialog's Create would, but with no dialog open the message names where to fix it.
export function directCreateAgentFailure(
  agent: TuiAgent,
  launchHost: ExecutionHostPlatformFact
): string {
  const label = getAgentLabel(agent)
  return launchHost.kind === 'withheld'
    ? translate(
        'auto.components.sidebar.folderWorkspaceCreate.agentHostUnknown',
        'Could not start {{agent}}. {{reason}}',
        { agent: label, reason: launchHost.reason }
      )
    : translate(
        'auto.components.sidebar.folderWorkspaceCreate.agentStartFailed',
        'Could not start {{agent}}. Check its Arguments in Settings → Agents, then try again.',
        { agent: label }
      )
}
