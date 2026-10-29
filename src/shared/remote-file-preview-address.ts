/** A file on a paired runtime that the desktop streams to a viewer by byte range. */
export type RemoteFilePreviewAddress = {
  environmentId: string
  /** Runtime worktree selector, e.g. 'id:wt-1'. */
  worktree: string
  relativePath: string
  expectedEnvironmentPairingRevision?: number
}

/** The renderer sends this over IPC; containment stays with the host's `files.*` checks. */
export function parseRemoteFilePreviewAddress(value: unknown): RemoteFilePreviewAddress | null {
  if (typeof value !== 'object' || value === null) {
    return null
  }
  const fields: ReadonlyMap<string, unknown> = new Map(Object.entries(value))
  const environmentId = fields.get('environmentId')
  const worktree = fields.get('worktree')
  const relativePath = fields.get('relativePath')
  const expectedEnvironmentPairingRevision = fields.get('expectedEnvironmentPairingRevision')
  if (
    typeof environmentId !== 'string' ||
    !environmentId ||
    typeof worktree !== 'string' ||
    !worktree ||
    typeof relativePath !== 'string' ||
    !relativePath ||
    /^([/\\]|[A-Za-z]:[/\\])/.test(relativePath) ||
    relativePath.includes('\0') ||
    (expectedEnvironmentPairingRevision !== undefined &&
      !Number.isSafeInteger(expectedEnvironmentPairingRevision))
  ) {
    return null
  }
  return {
    environmentId,
    worktree,
    relativePath,
    ...(typeof expectedEnvironmentPairingRevision === 'number'
      ? { expectedEnvironmentPairingRevision }
      : {})
  }
}
