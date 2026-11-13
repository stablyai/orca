import {
  agentPickerLaunchInputs,
  agentPickerFreshLaunchInputs,
  type AgentPickerDraft,
  type AgentPickerEntry
} from '../../../../../shared/agent-launch/picker/agent-launch-picker'
import type { ExecutionHostId } from '../../../../../shared/execution-host'
import type { TuiAgent } from '../../../../../shared/agent-launch/catalog/tui-agent'
import type { ProspectiveWorkspace } from '@/lib/agent-session/launch/routing/agent-launch-route-input'
import {
  isTuiAgentEnabled,
  pickTuiAgent,
  TUI_AGENT_AUTO_PICK_ORDER
} from '../../../../../shared/agent-launch/catalog/tui-agent-selection'

/** `offeredAgentIds`: chosen agents that open as a chat without a CLI; auto-picks stay detected. */
export function pickQuickWorkspaceAgent(
  preferred: TuiAgent | 'blank' | null | undefined,
  detectedAgentIds: Iterable<TuiAgent> | null,
  disabledTuiAgents?: Iterable<unknown> | null,
  offeredAgentIds?: ReadonlySet<TuiAgent> | null,
  chosenUsable?: (agent: TuiAgent) => boolean
): TuiAgent | null {
  const candidates = detectedAgentIds ?? TUI_AGENT_AUTO_PICK_ORDER
  return pickTuiAgent(preferred, candidates, disabledTuiAgents, (agent) =>
    Boolean(offeredAgentIds?.has(agent) || chosenUsable?.(agent))
  )
}

function hasDetectedAgent(detectedAgentIds: Iterable<TuiAgent>, agent: TuiAgent): boolean {
  if (detectedAgentIds instanceof Set) {
    return detectedAgentIds.has(agent)
  }
  for (const detectedAgentId of detectedAgentIds) {
    if (detectedAgentId === agent) {
      return true
    }
  }
  return false
}

function isQuickWorkspaceAgentAvailable(
  agent: TuiAgent,
  detectedAgentIds: Iterable<TuiAgent> | null,
  disabledTuiAgents?: Iterable<unknown> | null
): boolean {
  if (!isTuiAgentEnabled(agent, disabledTuiAgents)) {
    return false
  }
  return detectedAgentIds === null || hasDetectedAgent(detectedAgentIds, agent)
}

export function resolveQuickWorkspaceAgentSelection({
  quickAgentOverride,
  preferredQuickAgent,
  detectedAgentIds,
  disabledTuiAgents,
  offeredAgentIds,
  selectedChoiceUnresolved = false
}: {
  offeredAgentIds?: ReadonlySet<TuiAgent> | null
  selectedChoiceUnresolved?: boolean
  quickAgentOverride: TuiAgent | null | undefined
  preferredQuickAgent: TuiAgent | null
  detectedAgentIds: Iterable<TuiAgent> | null
  disabledTuiAgents?: Iterable<unknown> | null
}): {
  quickAgent: TuiAgent | null
  quickAgentOverride: TuiAgent | null | undefined
} {
  if (quickAgentOverride === undefined || quickAgentOverride === null) {
    return {
      quickAgent: quickAgentOverride === undefined ? preferredQuickAgent : null,
      quickAgentOverride
    }
  }
  if (
    isTuiAgentEnabled(quickAgentOverride, disabledTuiAgents) &&
    (selectedChoiceUnresolved ||
      offeredAgentIds?.has(quickAgentOverride) ||
      isQuickWorkspaceAgentAvailable(quickAgentOverride, detectedAgentIds, disabledTuiAgents))
  ) {
    return { quickAgent: quickAgentOverride, quickAgentOverride }
  }
  return { quickAgent: preferredQuickAgent, quickAgentOverride: undefined }
}

/** The workspace a composer's create would launch its agent in, before it exists. */
export function composerLaunchWorkspace(props: {
  repoId?: string | null
  selectedRepoIsGit?: boolean
  selectedRepoExecutionHostId?: string | null
}): ProspectiveWorkspace {
  return {
    kind: props.selectedRepoIsGit === false ? 'folder' : 'git-worktree',
    ...(props.repoId ? { repoId: props.repoId } : {}),
    ...(props.selectedRepoExecutionHostId
      ? { executionHostId: props.selectedRepoExecutionHostId }
      : {})
  }
}

export function quickWorkspacePickerInputs(
  draft: AgentPickerDraft | undefined,
  entry: AgentPickerEntry | undefined,
  executionHostId: ExecutionHostId | undefined
) {
  if (!draft) {
    return {}
  }
  const legacyDraft =
    draft.surface === 'terminal' && draft.arguments === undefined && entry && !entry.defaultsPending
      ? { ...draft, arguments: entry.arguments ?? null }
      : draft
  return {
    launchInputs: agentPickerFreshLaunchInputs(
      draft,
      { surface: draft.surface, executionHostId },
      entry
    ),
    legacyLaunchInputs: agentPickerLaunchInputs(legacyDraft, entry)
  }
}
