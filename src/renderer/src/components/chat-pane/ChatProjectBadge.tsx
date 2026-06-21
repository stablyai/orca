import { Cloud, Monitor } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useAppStore } from '@/store'
import { parseWorkspaceKey } from '../../../../shared/workspace-scope'
import {
  getRepoIdFromWorktreeId,
  splitWorktreeIdForFilesystem
} from '../../../../shared/worktree-id'

/** Always-on binding badge for a chat pane: shows WHICH project the chat is bound
 *  to, its working dir, and whether it runs 本地 (local) or 远程 (on an SSH host).
 *  Resolved from the chat's OWN worktreeId/cwd (NOT the globally-active workspace),
 *  so a chat created in project A keeps showing A even if the sidebar now
 *  highlights B — which is exactly the confusion that prompted this. Handles both
 *  folder workspaces and git worktrees (the previous version only handled folder
 *  workspaces, so a remote GIT project like ComfyUI showed nothing). For a folder
 *  workspace bound to SSH it keeps the brain-local on/off toggle; a remote git
 *  worktree is always brain-local (jcode local, bash on the host). Lives in its
 *  own file so ChatPane stays under the max-lines lint. */
export function ChatProjectBadge({
  worktreeId,
  cwd
}: {
  worktreeId?: string
  cwd?: string
}): React.JSX.Element | null {
  const scope = worktreeId ? parseWorkspaceKey(worktreeId) : null
  const folderWorkspaceId = scope?.type === 'folder' ? scope.folderWorkspaceId : undefined
  // A raw `repoId::path` worktree id has no `worktree:`/`folder:` prefix, so
  // parseWorkspaceKey returns null — fall back to the raw value for git worktrees.
  const rawWorktreeId = scope?.type === 'worktree' ? scope.worktreeId : worktreeId
  const repoId =
    !folderWorkspaceId && rawWorktreeId ? getRepoIdFromWorktreeId(rawWorktreeId) : undefined

  const folderWorkspace = useAppStore((state) =>
    folderWorkspaceId
      ? state.folderWorkspaces.find((entry) => entry.id === folderWorkspaceId)
      : undefined
  )
  const repo = useAppStore((state) =>
    repoId ? state.repos.find((entry) => entry.id === repoId) : undefined
  )
  const updateFolderWorkspace = useAppStore((state) => state.updateFolderWorkspace)
  const connectionId = folderWorkspace?.connectionId ?? repo?.connectionId ?? null
  const hostLabel = useAppStore((state) =>
    connectionId ? (state.sshTargetLabels.get(connectionId) ?? connectionId) : null
  )

  if (!worktreeId) {
    return null
  }

  const path =
    cwd?.trim() ||
    folderWorkspace?.folderPath ||
    (rawWorktreeId ? (splitWorktreeIdForFilesystem(rawWorktreeId)?.worktreePath ?? null) : null)
  const projectName =
    repo?.displayName ||
    (folderWorkspace?.folderPath ? folderWorkspace.folderPath.split('/').pop() : undefined) ||
    (path ? path.split('/').pop() : undefined) ||
    '工作区'
  const isRemote = !!connectionId
  // The folder-workspace toggle (brain-local on/off) is only meaningful for a
  // folder workspace bound to SSH; a remote git worktree is always brain-local.
  const showFolderToggle = !!folderWorkspaceId && !!folderWorkspace?.connectionId
  const folderEnabled = folderWorkspace?.isRemoteExecOnly === true

  return (
    <div className="flex items-center justify-between gap-2 border-b border-border px-4 py-1.5 text-xs">
      <div className="flex min-w-0 items-center gap-1.5">
        {isRemote ? (
          <Cloud className="size-3.5 shrink-0 text-muted-foreground" />
        ) : (
          <Monitor className="size-3.5 shrink-0 text-muted-foreground" />
        )}
        <span className="shrink-0 font-medium text-foreground">{projectName}</span>
        {path ? (
          <span className="truncate text-muted-foreground" title={path}>
            {path}
          </span>
        ) : null}
        <span
          className={cn(
            'shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium',
            isRemote ? 'bg-primary/15 text-primary' : 'bg-muted text-muted-foreground'
          )}
        >
          {isRemote ? `远程 · ${hostLabel}` : '本地'}
        </span>
      </div>
      {showFolderToggle ? (
        <button
          type="button"
          onClick={() => {
            void updateFolderWorkspace(folderWorkspaceId!, { isRemoteExecOnly: !folderEnabled })
          }}
          className={cn(
            'shrink-0 rounded px-2 py-0.5 font-medium',
            folderEnabled
              ? 'bg-primary text-primary-foreground'
              : 'bg-muted text-foreground hover:bg-muted/80'
          )}
        >
          {folderEnabled ? 'Hands remote: on' : 'Hands remote: off'}
        </button>
      ) : isRemote ? (
        <span className="shrink-0 text-[10px] text-muted-foreground">brain-local（自动）</span>
      ) : null}
    </div>
  )
}
