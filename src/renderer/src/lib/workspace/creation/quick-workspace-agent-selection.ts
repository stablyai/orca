import {
  agentPickerLaunchInputs,
  agentPickerFreshLaunchInputs,
  type AgentPickerDraft,
  type AgentPickerEntry
} from '../../../../../shared/agent-launch/picker/agent-launch-picker'
import type { ExecutionHostId } from '../../../../../shared/execution-host/execution-host'
import type { ProspectiveWorkspace } from '@/lib/agent-session/launch/routing/agent-launch-route-input'

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
