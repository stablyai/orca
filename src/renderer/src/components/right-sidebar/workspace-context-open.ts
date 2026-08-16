import { toast } from 'sonner'
import type { AgentContextReport } from '../../../../shared/agent-context'
import { toWindowsWslPath } from '../../../../shared/wsl-paths'
import { detectLanguage } from '@/lib/language-detect'
import { joinPath } from '@/lib/path'
import { translate } from '@/i18n/i18n'
import type { OpenFile } from '@/store/slices/editor'
import { isPathInside } from './workspace-context-model'

export type WorkspaceContextOpenArgs = {
  /** The path as the report shows it — POSIX for a WSL read. */
  displayPath: string
  reportTarget: AgentContextReport['target']
  worktree: { id: string; path: string }
  /** Whether Orca may open files outside the worktree on this workspace's host. */
  allowAbsolutePaths: boolean
  authorizeExternalPath: (args: { targetPath: string }) => Promise<void>
  openFile: (
    file: Omit<OpenFile, 'id' | 'isDirty'>,
    options?: { preview?: boolean; suppressActiveRuntimeFallback?: boolean }
  ) => void
}

function relativeToWorkspace(pathValue: string, workspaceCwd: string): string {
  const normalized = pathValue.replace(/\\/g, '/')
  const base = workspaceCwd.replace(/\\/g, '/').replace(/\/+$/, '')
  return normalized.slice(base.length + 1)
}

/** The path node fs opens for a report path: WSL reads go through the UNC mount. */
export function workspaceContextAccessPath(
  displayPath: string,
  reportTarget: AgentContextReport['target']
): string {
  return reportTarget.kind === 'wsl' && reportTarget.distro
    ? toWindowsWslPath(displayPath, reportTarget.distro)
    : displayPath
}

/**
 * Whether a row can open in the editor: anything inside the worktree always
 * can; a file elsewhere on disk (home configs, plugin caches) only when the
 * workspace is local, where Orca's external-file grant applies.
 */
export function canOpenWorkspaceContextPath(
  args: Pick<WorkspaceContextOpenArgs, 'displayPath' | 'reportTarget' | 'allowAbsolutePaths'>
): boolean {
  const workspaceCwd = args.reportTarget.cwd
  if (workspaceCwd && isPathInside(args.displayPath, workspaceCwd)) {
    return true
  }
  return args.allowAbsolutePaths
}

/** Open a report path in the editor, as a worktree file when it is one, else as an authorized external file. */
export async function openWorkspaceContextPath(args: WorkspaceContextOpenArgs): Promise<void> {
  const { displayPath, reportTarget, worktree } = args
  const workspaceCwd = reportTarget.cwd
  if (workspaceCwd && isPathInside(displayPath, workspaceCwd)) {
    const relativePath = relativeToWorkspace(displayPath, workspaceCwd)
    args.openFile({
      filePath: joinPath(worktree.path, relativePath),
      relativePath,
      worktreeId: worktree.id,
      language: detectLanguage(relativePath),
      mode: 'edit'
    })
    return
  }
  if (!args.allowAbsolutePaths) {
    return
  }
  const accessPath = workspaceContextAccessPath(displayPath, reportTarget)
  try {
    // Why: the click is the trust gesture; the exact path is what gets granted.
    await args.authorizeExternalPath({ targetPath: accessPath })
  } catch {
    toast.error(
      translate(
        'auto.components.rightSidebar.WorkspaceContextPanel.openNotAuthorized',
        "Couldn't open {{value0}} — path not authorized.",
        { value0: displayPath }
      )
    )
    return
  }
  args.openFile(
    {
      filePath: accessPath,
      // Why: an external file keeps relativePath === filePath so the editor
      // reads the authorized path, not a worktree-relative reinterpretation.
      relativePath: accessPath,
      worktreeId: worktree.id,
      // Why: read on the client-local host — pin local ownership so an active
      // runtime cannot reinterpret the path as remote.
      runtimeEnvironmentId: null,
      language: detectLanguage(accessPath),
      mode: 'edit'
    },
    { preview: false, suppressActiveRuntimeFallback: true }
  )
}
