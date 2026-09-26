import {
  getAiVaultResumeWorkspaceExecutionHostId,
  getAiVaultResumeWorkspaceTargetStatus
} from '@/lib/ai-vault-resume-target'
import {
  resolveAiVaultContinuationBridge,
  type AiVaultContinuationBridge
} from '@/lib/ai-vault-continuation-target'
import type { AiVaultSessionResumeTargetState } from '@/components/right-sidebar/ai-vault-session-resume'
import {
  getExecutionHostDisplayLabel,
  type ExecutionHostNameSources
} from '@/lib/execution-host-display-label'
import { LOCAL_EXECUTION_HOST_ID, type ExecutionHostId } from '../../../../shared/execution-host'
import { folderWorkspaceKey } from '../../../../shared/workspace-scope'
import type { Worktree } from '../../../../shared/worktree/types'

export type ContinuationTargetOption = {
  workspaceId: string
  label: string
  workspacePath: string
  executionHostId: ExecutionHostId
  bridge: AiVaultContinuationBridge
}

export type ContinuationTargetHostGroup = {
  executionHostId: ExecutionHostId
  hostLabel: string
  options: ContinuationTargetOption[]
}

type ContinuationTargetSource = {
  sessionFilePath: string | null | undefined
  sessionExecutionHostId?: ExecutionHostId | null
}

function toTargetOption(args: {
  workspaceId: string
  label: string
  workspacePath: string
  state: AiVaultSessionResumeTargetState
  source: ContinuationTargetSource
}): ContinuationTargetOption | null {
  const executionHostId = getAiVaultResumeWorkspaceExecutionHostId(args.state, args.workspaceId)
  if (!executionHostId) {
    return null
  }
  return {
    workspaceId: args.workspaceId,
    label: args.label,
    workspacePath: args.workspacePath,
    executionHostId,
    bridge: resolveAiVaultContinuationBridge({
      sessionFilePath: args.source.sessionFilePath,
      sessionExecutionHostId: args.source.sessionExecutionHostId,
      targetStatus: getAiVaultResumeWorkspaceTargetStatus(args.state, args.workspaceId),
      targetExecutionHostId: executionHostId
    })
  }
}

/**
 * Workspaces a session can be continued in, grouped by the host that owns them.
 * Hosts appear even when nothing on them can take this session, so the picker
 * can say why instead of hiding the option.
 */
export function buildContinuationTargetGroups(args: {
  state: AiVaultSessionResumeTargetState
  worktrees: readonly Worktree[]
  source: ContinuationTargetSource
  hostNames: ExecutionHostNameSources
}): ContinuationTargetHostGroup[] {
  const options: ContinuationTargetOption[] = []

  for (const worktree of args.worktrees) {
    const option = toTargetOption({
      workspaceId: worktree.id,
      label: worktree.displayName || worktree.path,
      workspacePath: worktree.path,
      state: args.state,
      source: args.source
    })
    if (option) {
      options.push(option)
    }
  }

  for (const workspace of args.state.folderWorkspaces) {
    const option = toTargetOption({
      workspaceId: folderWorkspaceKey(workspace.id),
      label: workspace.name || workspace.folderPath,
      workspacePath: workspace.folderPath,
      state: args.state,
      source: args.source
    })
    if (option) {
      options.push(option)
    }
  }

  const groups = new Map<ExecutionHostId, ContinuationTargetHostGroup>()
  for (const option of options) {
    const group = groups.get(option.executionHostId) ?? {
      executionHostId: option.executionHostId,
      hostLabel: getExecutionHostDisplayLabel(option.executionHostId, args.hostNames),
      options: []
    }
    group.options.push(option)
    groups.set(option.executionHostId, group)
  }

  for (const group of groups.values()) {
    group.options.sort((left, right) => left.label.localeCompare(right.label))
  }

  // Why: the local host is the familiar anchor, so it leads regardless of label order.
  return [...groups.values()].sort((left, right) => {
    if (left.executionHostId === LOCAL_EXECUTION_HOST_ID) {
      return -1
    }
    if (right.executionHostId === LOCAL_EXECUTION_HOST_ID) {
      return 1
    }
    return left.hostLabel.localeCompare(right.hostLabel)
  })
}

export function isContinuationTargetSelectable(option: ContinuationTargetOption): boolean {
  return option.bridge.kind !== 'unavailable'
}

export function findContinuationTargetOption(
  groups: readonly ContinuationTargetHostGroup[],
  workspaceId: string | null
): ContinuationTargetOption | null {
  if (!workspaceId) {
    return null
  }
  for (const group of groups) {
    const match = group.options.find((option) => option.workspaceId === workspaceId)
    if (match) {
      return match
    }
  }
  return null
}
