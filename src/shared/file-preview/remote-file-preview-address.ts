import type { RemoteFileLocator } from '../file-access/remote-file-locator'

/** A file on a paired runtime that the desktop streams to a viewer by byte range. */
export type RemoteFilePreviewAddress = {
  environmentId: string
  /** Runtime worktree selector, e.g. 'id:wt-1'. */
  worktree: string
  expectedEnvironmentPairingRevision?: number
} & RemoteFileLocator

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && !value.includes('\0')
}

const ABSOLUTE_PATH = /^([/\\]|[A-Za-z]:[/\\])/

function parseLocator(fields: ReadonlyMap<string, unknown>): RemoteFileLocator | null {
  const relativePath = fields.get('relativePath')
  const grantId = fields.get('grantId')
  const absolutePath = fields.get('absolutePath')
  if (grantId === undefined && absolutePath === undefined) {
    return nonEmptyString(relativePath) && !ABSOLUTE_PATH.test(relativePath)
      ? { relativePath }
      : null
  }
  return relativePath === undefined &&
    nonEmptyString(grantId) &&
    nonEmptyString(absolutePath) &&
    ABSOLUTE_PATH.test(absolutePath)
    ? { grantId, absolutePath }
    : null
}

/** The renderer sends this over IPC; containment stays with the host's `files.*` checks and grants. */
export function parseRemoteFilePreviewAddress(value: unknown): RemoteFilePreviewAddress | null {
  if (typeof value !== 'object' || value === null) {
    return null
  }
  const fields: ReadonlyMap<string, unknown> = new Map(Object.entries(value))
  const environmentId = fields.get('environmentId')
  const worktree = fields.get('worktree')
  const expectedEnvironmentPairingRevision = fields.get('expectedEnvironmentPairingRevision')
  const locator = parseLocator(fields)
  if (
    !locator ||
    typeof environmentId !== 'string' ||
    !environmentId ||
    typeof worktree !== 'string' ||
    !worktree ||
    (expectedEnvironmentPairingRevision !== undefined &&
      !Number.isSafeInteger(expectedEnvironmentPairingRevision))
  ) {
    return null
  }
  return {
    environmentId,
    worktree,
    ...locator,
    ...(typeof expectedEnvironmentPairingRevision === 'number'
      ? { expectedEnvironmentPairingRevision }
      : {})
  }
}
