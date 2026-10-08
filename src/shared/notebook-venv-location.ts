import { isPathInsideOrEqual } from './cross-platform-path'

/** Where a notebook's new `.venv` goes: the workspace root when the notebook is inside it, else beside it. */
export function notebookVenvParent(notebookPath: string, rootPath: string | null): string {
  if (rootPath && isPathInsideOrEqual(rootPath, notebookPath)) {
    return rootPath
  }
  const separator = Math.max(notebookPath.lastIndexOf('/'), notebookPath.lastIndexOf('\\'))
  const parent = notebookPath.slice(0, separator)
  // A notebook at a filesystem root keeps the root's separator: `/`, `C:\\`.
  return parent === '' || /^[A-Za-z]:$/.test(parent) ? notebookPath.slice(0, separator + 1) : parent
}

/** Path segments from a venv's folder to its interpreter. */
export function venvInterpreterSegments(windows: boolean): string[] {
  return windows ? ['Scripts', 'python.exe'] : ['bin', 'python']
}
