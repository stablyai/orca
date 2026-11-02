import type {
  PluginViewReply,
  PluginViewRequest
} from '../../../../../shared/plugins/view/plugin-view-protocol'
import { detectLanguage } from '@/lib/language-detect'
import { dispatchAppCommand } from '@/lib/app-command-dispatch'
import { useAppStore } from '@/store'
import { getIndexedWorktreeMap } from '@/store/worktree-repo-index'
import { selectFolderWorkspaces, selectWorktreesByRepo } from '@/store/workspace-record-selectors'
import { parseWorkspaceKey } from '../../../../../shared/workspace-scope'

/** A plugin worker's `editor.open` and `commands.run`, run in this window. */

const fail = (requestId: string, code: string, message: string): PluginViewReply => ({
  requestId,
  ok: false,
  code,
  message
})

/** The workspace path and a relative one joined with the workspace's own separator. */
function workspaceFilePath(worktreePath: string, relativePath: string): string {
  const separator = worktreePath.includes('\\') && !worktreePath.includes('/') ? '\\' : '/'
  const parts = relativePath.split(/[\\/]/).filter((part) => part !== '' && part !== '.')
  return [worktreePath.replace(/[\\/]+$/, ''), ...parts].join(separator)
}

export function openWorkspaceFile(
  request: Extract<PluginViewRequest, { kind: 'open-file' }>
): PluginViewReply {
  const { requestId, worktreeId, relativePath } = request
  const state = useAppStore.getState()
  const scope = parseWorkspaceKey(worktreeId)
  const root =
    scope?.type === 'folder'
      ? selectFolderWorkspaces(state)?.find((folder) => folder.id === scope.folderWorkspaceId)
          ?.folderPath
      : getIndexedWorktreeMap(selectWorktreesByRepo(state)).get(worktreeId)?.path
  if (!root) {
    return fail(requestId, 'workspace_not_found', `This window does not list ${worktreeId}.`)
  }
  const filePath = workspaceFilePath(root, relativePath)
  state.openFile(
    {
      filePath,
      relativePath: relativePath.split(/[\\/]/).filter(Boolean).join('/'),
      worktreeId,
      language: detectLanguage(filePath),
      mode: 'edit'
    },
    { preview: false }
  )
  return { requestId, ok: true }
}

export function runBuiltInAction(
  request: Extract<PluginViewRequest, { kind: 'run-action' }>
): PluginViewReply {
  return dispatchAppCommand(request.action, 'plugin-host')
    ? { requestId: request.requestId, ok: true }
    : fail(request.requestId, 'action_unavailable', `${request.action} cannot run in this view.`)
}
