// Shared between renderer (clone autofill, GitHub panel) and main (cloned-repo
// file cleanup), which is why this pure path logic cannot live under renderer/.

export function getDefaultCloneParent(workspaceDir: string): string {
  if (!workspaceDir) {
    return ''
  }

  const trimmed = workspaceDir.replace(/[\\/]+$/, '')
  if (!trimmed) {
    return workspaceDir
  }

  const separatorIndex = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'))
  const lastSegment = separatorIndex === -1 ? trimmed : trimmed.slice(separatorIndex + 1)

  if (lastSegment !== 'workspaces') {
    return workspaceDir
  }

  // Why: default Orca worktrees live under "workspaces"; clones should sit beside that tree.
  const parent = separatorIndex === -1 ? '' : trimmed.slice(0, separatorIndex)
  if (parent === '' && trimmed.startsWith('/')) {
    return '/'
  }
  if (/^[A-Za-z]:$/.test(parent)) {
    return `${parent}${trimmed[separatorIndex]}`
  }
  return parent
}

// Variant for the GitHub account panel: clones land in a sibling "projects"
// tree (`~/orca/projects/<repo>`) instead of directly beside "workspaces".
// The sidebar clone flow intentionally keeps getDefaultCloneParent unchanged.
export function getDefaultProjectsCloneParent(workspaceDir: string): string {
  if (!workspaceDir) {
    return ''
  }

  const trimmed = workspaceDir.replace(/[\\/]+$/, '')
  if (!trimmed) {
    return workspaceDir
  }

  const separatorIndex = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'))
  const lastSegment = separatorIndex === -1 ? trimmed : trimmed.slice(separatorIndex + 1)

  if (lastSegment !== 'workspaces') {
    return workspaceDir
  }

  const separator = separatorIndex === -1 ? '/' : trimmed[separatorIndex]
  const parent = separatorIndex === -1 ? '' : trimmed.slice(0, separatorIndex)
  if (parent === '') {
    return trimmed.startsWith('/') ? '/projects' : 'projects'
  }
  return `${parent}${separator}projects`
}
