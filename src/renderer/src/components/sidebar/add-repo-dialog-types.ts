export type AddRepoDialogStep = 'add' | 'clone' | 'remote' | 'server-path' | 'create' | 'nested'

export function defaultProjectGroupNameForPath(path: string): string {
  return (
    path
      .replace(/[\\/]+$/g, '')
      .split(/[\\/]/)
      .findLast(Boolean) ?? path
  )
}

export function createNestedRepoScanId(): string {
  return `nested-repo-scan-${Date.now()}-${Math.random().toString(36).slice(2)}`
}
