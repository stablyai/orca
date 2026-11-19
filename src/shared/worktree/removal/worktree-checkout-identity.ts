import { parseGitdirMarkerPayload } from '../../git/metadata/gitdir-marker-payload'
import { resolveGitMetadataPath } from '../../git/metadata/git-metadata-path'
import type { BigIntStats } from 'node:fs'
import { basename, dirname } from 'node:path'

export const WORKTREE_CHECKOUT_NONCE = 'orca-cleanup-incarnation'
export const WORKTREE_IDENTITY_FILE_LIMIT = 128 * 1024
export type WorktreeCheckoutIdentity = Readonly<{
  instanceId: string
  root: string
  rootKey: string
  markerKey: string
  gitDir: string
  adminKey: string
  nonce: string
}>

export type WorktreeCheckoutSpawnGuard = {
  identity: WorktreeCheckoutIdentity
  checkoutRemoved?: true
}

export class WorktreeRemovalIncarnationChangedError extends Error {
  readonly code = 'ERR_ORCA_WORKTREE_CHANGED'
  constructor() {
    super('The workspace incarnation changed before deletion; it was not removed.')
  }
}

export function isWorktreeIncarnationChanged(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ERR_ORCA_WORKTREE_CHANGED'
}

export function checkoutDirectoryKey(stats: BigIntStats): string {
  if (!stats.isDirectory() || stats.isSymbolicLink() || stats.ino === 0n) {
    throw new WorktreeRemovalIncarnationChangedError()
  }
  return `${stats.dev}:${stats.ino}:${stats.birthtimeNs}`
}

export function checkoutGitDirectory(root: string, text: string): string {
  const marker = parseGitdirMarkerPayload(text)
  const gitDir = marker ? resolveGitMetadataPath(root, marker) : null
  if (!gitDir) {
    throw new WorktreeRemovalIncarnationChangedError()
  }
  return gitDir
}

export function assertCheckoutMetadata(gitDir: string, nonce: string): void {
  if (basename(dirname(gitDir)) !== 'worktrees' || !/^[0-9a-f-]{36}$/.test(nonce)) {
    throw new WorktreeRemovalIncarnationChangedError()
  }
}

export function assertCheckoutIdentityMatches(
  expected: WorktreeCheckoutIdentity,
  actual: WorktreeCheckoutIdentity
): void {
  if (
    (['instanceId', 'root', 'rootKey', 'markerKey', 'gitDir', 'adminKey', 'nonce'] as const).some(
      (key) => expected[key] !== actual[key]
    )
  ) {
    throw new WorktreeRemovalIncarnationChangedError()
  }
}

export function parseWorktreeCheckoutIdentity(value: unknown): WorktreeCheckoutIdentity | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return null
  }
  if (
    !('instanceId' in value) ||
    typeof value.instanceId !== 'string' ||
    !value.instanceId ||
    !('root' in value) ||
    typeof value.root !== 'string' ||
    !value.root ||
    !('rootKey' in value) ||
    typeof value.rootKey !== 'string' ||
    !value.rootKey ||
    !('markerKey' in value) ||
    typeof value.markerKey !== 'string' ||
    !value.markerKey ||
    !('gitDir' in value) ||
    typeof value.gitDir !== 'string' ||
    !value.gitDir ||
    !('adminKey' in value) ||
    typeof value.adminKey !== 'string' ||
    !value.adminKey ||
    !('nonce' in value) ||
    typeof value.nonce !== 'string' ||
    !value.nonce
  ) {
    return null
  }
  return Object.freeze({
    instanceId: value.instanceId,
    root: value.root,
    rootKey: value.rootKey,
    markerKey: value.markerKey,
    gitDir: value.gitDir,
    adminKey: value.adminKey,
    nonce: value.nonce
  })
}
