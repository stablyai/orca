import { isWorktreeRetiredByRemoval } from '../../../../shared/worktree/removal/removal-visibility'
import { useAppStore } from '@/store'
import { getPaletteWorktreeExecutionHostId } from '@/lib/workspace/search/palette-repo-resolution'
import { getWorkspaceAttachments } from '../../../../shared/workspace-attachments/workspace-attachments'
import {
  getProvenWorkspaceReferenceIdentity,
  parseWorkspaceReferenceUrl
} from '../../../../shared/workspace-attachments/workspace-reference-identity'
import '@/lib/workspace/creation/new-workspace'
import type { Worktree } from '../../../../shared/worktree/types'
import {
  haveConflictingTaskSourceAccounts,
  type TaskSourceContext
} from '../../../../shared/work-items/task-source-context'
import { describeCmdJTask, type CmdJTaskSearchResult } from './task-search-results'
import { buildCmdJLinkedWorkItem, getCmdJWorkspaceSeed } from './task-search-workspace-source'

function sourceMatches(source: TaskSourceContext, target: TaskSourceContext): boolean {
  if (source.provider !== target.provider || source.hostId !== target.hostId) {
    return false
  }
  if (haveConflictingTaskSourceAccounts(source, target)) {
    return false
  }
  const left = source.providerIdentity
  const right = target.providerIdentity
  return !(
    left?.provider === 'linear' &&
    right?.provider === 'linear' &&
    left.workspaceId &&
    right.workspaceId &&
    left.workspaceId !== right.workspaceId
  )
}

export function findCmdJTaskWorkspace(
  result: CmdJTaskSearchResult,
  workspaces: readonly Worktree[]
): Worktree | undefined {
  let identity: string | undefined
  try {
    identity = getProvenWorkspaceReferenceIdentity(
      result.task.provider === 'clickup'
        ? {
            provider: 'clickup',
            type: 'issue',
            number: 0,
            url: result.task.task.url,
            clickupIdentifier: result.task.task.id
          }
        : parseWorkspaceReferenceUrl(describeCmdJTask(result.task).url, result.task.provider)
    )
  } catch {
    return undefined
  }
  if (!identity) {
    return undefined
  }
  return workspaces
    .filter((workspace) => !workspace.isArchived && !isWorktreeRetiredByRemoval(workspace))
    .find((workspace) =>
      getWorkspaceAttachments(workspace).some((item) => {
        if (
          item.provider !== result.task.provider ||
          getProvenWorkspaceReferenceIdentity(item) !== identity
        ) {
          return false
        }
        // Legacy links have no source owner, so only their own execution host is safe.
        return item.taskSourceContext
          ? sourceMatches(item.taskSourceContext, result.sourceContext)
          : (getPaletteWorktreeExecutionHostId(workspace) ?? 'local') ===
              result.sourceContext.hostId
      })
    )
}

export function openCmdJTask(result: CmdJTaskSearchResult, createWorkspace = false): void {
  const state = useAppStore.getState()
  state.closeModal()
  const task = result.task
  if (createWorkspace) {
    const linkedWorkItem = buildCmdJLinkedWorkItem(task)
    const prefilledName = getCmdJWorkspaceSeed(task, linkedWorkItem)
    queueMicrotask(() =>
      useAppStore.getState().openModal('new-workspace-composer', {
        linkedWorkItem,
        prefilledName,
        initialRepoId: result.initialRepoId,
        taskSourceContext: result.sourceContext,
        telemetrySource: 'command_palette'
      })
    )
    return
  }
  const common = {
    taskSource: task.provider,
    ...(result.initialRepoId ? { preselectedRepoId: result.initialRepoId } : {})
  }
  state.openTaskPage(
    task.provider === 'linear'
      ? { ...common, openLinearIssue: task.issue, openLinearSourceContext: result.sourceContext }
      : task.provider === 'jira'
        ? { ...common, openJiraIssue: task.issue, openJiraSourceContext: result.sourceContext }
        : task.provider === 'clickup'
          ? {
              ...common,
              openClickUpTask: task.task,
              openClickUpSourceContext: result.sourceContext
            }
          : task.provider === 'github'
            ? {
                ...common,
                openGitHubWorkItem: task.issue,
                openGitHubSourceContext: result.sourceContext
              }
            : {
                ...common,
                openGitLabWorkItem: task.issue,
                openGitLabSourceContext: result.sourceContext
              },
    { recordTasksInteraction: false }
  )
}
