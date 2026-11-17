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
  /** Shiki grammar from `resolvePierreDiffLanguage`; omitted means Pierre guesses from the name. */
  lang?: string
  parseDiffOptions: CreatePatchOptionsNonabortable
}

function toFileContents(
  name: string,
  contents: string,
  cacheKey: string | undefined,
  lang: string | undefined
): FileContents {
  return { name, contents, ...(cacheKey ? { cacheKey } : {}), ...(lang ? { lang } : {}) }
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
    lang,
    parseDiffOptions
  }: PierreDiffInput,
  requestedIdentity?: string
): FileDiffMetadata {
  const isAdded = ADDED_STATUSES.has(status)
  const isDeleted = status === 'deleted'
  const identity =
    requestedIdentity ??
    getPierreDiffCacheIdentity(
      JSON.stringify([cacheKey, path, oldPath, status, lang, parseDiffOptions]),
      originalContent,
      modifiedContent
    )
  const oldFile = isAdded
    ? null
    : toFileContents(oldPath ?? path, originalContent, `${identity}:old`, lang)
  const newFile = isDeleted ? null : toFileContents(path, modifiedContent, `${identity}:new`, lang)

  return { ...parseDiffFromFile(oldFile, newFile, { ...parseDiffOptions }), cacheKey: identity }
}
