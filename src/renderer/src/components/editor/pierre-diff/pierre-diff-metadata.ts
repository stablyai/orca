import { parseDiffFromFile, type FileContents, type FileDiffMetadata } from '@pierre/diffs'
import type { CreatePatchOptionsNonabortable } from 'diff'
import { getPierreDiffCacheIdentity } from './pierre-diff-cache-identity'

/** Statuses whose old side does not exist, so Pierre should render an add. */
const ADDED_STATUSES = new Set(['added', 'untracked'])

export type PierreDiffInput = {
  path: string
  oldPath?: string
  status: string
  originalContent: string
  modifiedContent: string
  cacheKey?: string
  parseDiffOptions: CreatePatchOptionsNonabortable
}

function toFileContents(
  name: string,
  contents: string,
  cacheKey: string | undefined
): FileContents {
  return cacheKey ? { name, contents, cacheKey } : { name, contents }
}

/**
 * Builds the diff Pierre renders from the two blobs git already handed us, so
 * no wire change is needed. `cacheKey` lets the worker pool reuse a rendered AST
 * across virtualization remounts — memoize the call on the same identity.
 */
export function buildPierreFileDiff(
  {
    path,
    oldPath,
    status,
    originalContent,
    modifiedContent,
    cacheKey,
    parseDiffOptions
  }: PierreDiffInput,
  requestedIdentity?: string
): FileDiffMetadata {
  const isAdded = ADDED_STATUSES.has(status)
  const isDeleted = status === 'deleted'
  const identity =
    requestedIdentity ??
    getPierreDiffCacheIdentity(
      JSON.stringify([cacheKey, path, oldPath, status, parseDiffOptions]),
      originalContent,
      modifiedContent
    )
  const oldFile = isAdded
    ? null
    : toFileContents(oldPath ?? path, originalContent, `${identity}:old`)
  const newFile = isDeleted ? null : toFileContents(path, modifiedContent, `${identity}:new`)

  return { ...parseDiffFromFile(oldFile, newFile, { ...parseDiffOptions }), cacheKey: identity }
}
