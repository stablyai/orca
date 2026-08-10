import {
  GIT_STAGED_DISCARD_OPERATION_VERSION,
  GIT_STAGED_DISCARD_RUNTIME_CAPABILITY,
  GIT_STAGED_DISCARD_UPDATE_REQUIRED_MESSAGE
} from './protocol-version'

export function assertGitStagedDiscardCapability(status: unknown): void {
  if (!status || typeof status !== 'object') {
    throw new Error(GIT_STAGED_DISCARD_UPDATE_REQUIRED_MESSAGE)
  }
  const capabilities = (status as { capabilities?: unknown }).capabilities
  if (
    !Array.isArray(capabilities) ||
    !capabilities.every((capability) => typeof capability === 'string') ||
    !capabilities.includes(GIT_STAGED_DISCARD_RUNTIME_CAPABILITY)
  ) {
    throw new Error(GIT_STAGED_DISCARD_UPDATE_REQUIRED_MESSAGE)
  }
}

export function supportsGitStagedDiscardOperation(capabilities: unknown): boolean {
  if (!capabilities || typeof capabilities !== 'object') {
    return false
  }
  return (
    (capabilities as { stagedDiscardOperationVersion?: unknown }).stagedDiscardOperationVersion ===
    GIT_STAGED_DISCARD_OPERATION_VERSION
  )
}

export function gitStagedDiscardArgs(pathspecs: readonly string[], source = 'HEAD'): string[] {
  return ['restore', `--source=${source}`, '--staged', '--worktree', '--', ...pathspecs]
}

export function gitStagedDiscardStatusArgs(): string[] {
  return ['status', '--porcelain=v1', '-z', '--untracked-files=no', '--renames']
}

const UNMERGED_STATUS_CODES = new Set(['DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU'])

export function resolveGitStagedDiscardPaths(
  statusOutput: string,
  selectedPaths: readonly string[],
  normalizePath: (filePath: string) => string = (filePath) => filePath
): { paths: string[]; hasConflict: boolean } {
  const selected = new Set(selectedPaths.map(normalizePath))
  const renameSourceByDestination = new Map<string, string>()
  const renameDestinationBySource = new Map<string, string>()
  const fields = statusOutput.split('\0')
  let hasConflict = false
  for (let index = 0; index < fields.length; index += 1) {
    const field = fields[index]
    if (field.length < 4) {
      continue
    }
    const xy = field.slice(0, 2)
    const currentPath = field.slice(3)
    const currentKey = normalizePath(currentPath)
    if (selected.has(currentKey)) {
      hasConflict ||= UNMERGED_STATUS_CODES.has(xy)
    }
    if (!xy.includes('R')) {
      continue
    }
    const oldPath = fields[index + 1]
    index += 1
    if (oldPath) {
      renameSourceByDestination.set(currentKey, oldPath)
      renameDestinationBySource.set(normalizePath(oldPath), currentPath)
    }
  }
  const paths: string[] = []
  const seen = new Set<string>()
  const add = (filePath: string | undefined): void => {
    if (filePath && !seen.has(filePath)) {
      seen.add(filePath)
      paths.push(filePath)
    }
  }
  for (const selectedPath of selectedPaths) {
    const selectedKey = normalizePath(selectedPath)
    add(selectedPath)
    add(renameSourceByDestination.get(selectedKey))
    add(renameDestinationBySource.get(selectedKey))
  }
  return { paths, hasConflict }
}
