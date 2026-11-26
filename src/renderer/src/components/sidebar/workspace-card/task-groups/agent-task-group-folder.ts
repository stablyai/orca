import { relativePathInsideRoot } from '../../../../../../shared/file-access/cross-platform-path'

export type TaskGroupFolderCheck =
  | { kind: 'root' }
  | { kind: 'inside'; folderPath: string; label: string }
  | { kind: 'outside' }

/** A group's folder must sit inside its workspace, so its conversations keep the workspace's tabs and host. */
export function checkTaskGroupFolder(
  workspaceRoot: string | null,
  raw: string
): TaskGroupFolderCheck {
  const folderPath = raw.trim()
  if (!folderPath) {
    return { kind: 'root' }
  }
  if (!workspaceRoot) {
    return { kind: 'inside', folderPath, label: folderPath }
  }
  const relative = relativePathInsideRoot(workspaceRoot, folderPath)
  if (relative === null) {
    return { kind: 'outside' }
  }
  return relative === ''
    ? { kind: 'root' }
    : { kind: 'inside', folderPath, label: relative.replaceAll('\\', '/') }
}

/** The folder as written below the workspace root, e.g. `DSC102/PA4`. */
export function taskGroupFolderLabel(workspaceRoot: string | null, folderPath: string): string {
  const check = checkTaskGroupFolder(workspaceRoot, folderPath)
  return check.kind === 'inside' ? check.label : folderPath
}

export function folderBaseName(folderPath: string): string {
  return (
    folderPath
      .replace(/[\\/]+$/, '')
      .split(/[\\/]/)
      .pop() || folderPath
  )
}
