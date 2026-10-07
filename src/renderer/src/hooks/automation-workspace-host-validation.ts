import type { Automation } from '../../../shared/automations-types'
import type { Repo } from '../../../shared/repo-types'
import type { Worktree } from '../../../shared/worktree/types'
import {
  getRepoExecutionHostId,
  parseExecutionHostId,
  toSshExecutionHostId
} from '../../../shared/execution-host'
import { resolveFolderWorkspaceHost } from '../../../shared/folder-workspace-execution-host'
import { parseWorkspaceKey } from '../../../shared/workspace-scope'
import { getResolvedExecutionHostIdForWorktree } from '@/lib/resolved-worktree-execution-host'
import { translate } from '@/i18n/i18n'
import type { useAppStore } from '@/store'

export function getAutomationWorkspaceHostError(
  state: ReturnType<typeof useAppStore.getState>,
  automation: Automation,
  repo: Repo,
  workspace: Worktree | null | undefined
): string | null {
  if (automation.workspaceMode !== 'existing' || !workspace) {
    return null
  }
  const scope = parseWorkspaceKey(automation.workspaceId ?? '')
  const runHostId =
    parseExecutionHostId(automation.runContext?.hostId)?.id ?? getRepoExecutionHostId(repo)
  if (scope?.type === 'folder') {
    const host = resolveFolderWorkspaceHost(state, scope.folderWorkspaceId)
    if (host.kind === 'ambiguous') {
      return translate(
        'auto.hooks.useAutomationDispatchEvents.workspaceHostUnresolved',
        'The target workspace spans more than one host, so this run has no single host to use.'
      )
    }
    const workspaceHostId =
      host.kind === 'ssh'
        ? toSshExecutionHostId(host.targetId)
        : host.kind === 'local'
          ? getResolvedExecutionHostIdForWorktree(state, workspace.id)
          : null
    if (workspaceHostId === runHostId) {
      return null
    }
  } else if (!automation.runContext?.repoId || workspace.repoId === automation.runContext.repoId) {
    return null
  }
  return translate(
    'auto.hooks.useAutomationDispatchEvents.3ad7d77f57',
    'The target workspace is on a different host than this automation run target.'
  )
}
