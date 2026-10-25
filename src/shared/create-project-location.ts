// Shared with mobile so a phone proposes the same host folders as the desktop Add Project dialog.
function pathSeparatorFor(pathValue: string): '/' | '\\' {
  return pathValue.includes('\\') ? '\\' : '/'
}

function trimTrailingSeparators(pathValue: string): string {
  const trimmed = pathValue.replace(/[\\/]+$/, '')
  if (trimmed === '' && pathValue.startsWith('/')) {
    return '/'
  }
  if (/^[A-Za-z]:$/.test(trimmed)) {
    return `${trimmed}${pathSeparatorFor(pathValue)}`
  }
  return trimmed
}

export function joinCreateProjectPath(parentPath: string, childName: string): string {
  const parent = trimTrailingSeparators(parentPath.trim())
  const child = childName.trim().replace(/^[\\/]+/, '')
  if (!parent || !child) {
    return parent || child
  }
  const separator = pathSeparatorFor(parent)
  if (parent === '/' || /^[A-Za-z]:[\\/]$/.test(parent)) {
    return `${parent}${child}`
  }
  return `${parent}${separator}${child}`
}

export function getDefaultCreateProjectParent(homeDir: string): string {
  const trimmedHomeDir = trimTrailingSeparators(homeDir.trim())
  if (!trimmedHomeDir) {
    return ''
  }
  return joinCreateProjectPath(joinCreateProjectPath(trimmedHomeDir, 'orca'), 'projects')
}
