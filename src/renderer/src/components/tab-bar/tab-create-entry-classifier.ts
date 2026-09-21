import { getPreparedQuickOpenFiles, isQuickOpenQueryTooLarge } from '../quick-open-search'
import type { RuntimeFileListState } from '../quick-open-file-list'
import { translate } from '@/i18n/i18n'
import { getTabEntryOmniboxPlaceholder } from './tab-create-entry-copy'
import { DEFAULT_SEARCH_ENGINE, type SearchEngine } from '../../../../shared/browser-url'
import { findExistingFileMatches, isLikelyNewFileIntent } from './tab-create-entry-file-matches'
import { parseForcedSearchQuery } from './tab-create-entry-forced-search'
import {
  isTabEntryAbsolutePathLike,
  type TabEntryLocalPlatform,
  validateNewTabEntryAbsolutePath,
  validateNewTabEntryRelativePath
} from './tab-create-entry-path-validation'
import { classifyExplicitUrl, classifyHostUrl } from './tab-create-entry-url-classification'

export {
  isTabEntryAbsolutePathLike,
  validateNewTabEntryAbsolutePath,
  validateNewTabEntryRelativePath
} from './tab-create-entry-path-validation'

export type TabEntryOptionsContext = {
  allowAbsolutePaths?: boolean
  localPlatform?: TabEntryLocalPlatform
  searchEngine?: SearchEngine
}

export const TAB_ENTRY_ABSOLUTE_PATH_REMOTE_BLOCKED_MESSAGE =
  'Absolute paths require a local workspace.'

export type TabEntryClassification =
  | { kind: 'empty'; message: string }
  | { kind: 'explicit-url'; url: string }
  | {
      kind: 'existing-file'
      matchKind: 'exact-path' | 'exact-basename' | 'fuzzy'
      relativePath: string
    }
  | { kind: 'host-url'; url: string }
  | { kind: 'search'; engine: SearchEngine; query: string }
  | { kind: 'new-file'; relativePath: string }
  | { kind: 'absolute-file'; filePath: string }
  | { kind: 'blocked'; message: string }

export type TabEntryActionClassification = Exclude<
  TabEntryClassification,
  { kind: 'blocked' | 'empty' }
>

export type TabEntryOption = {
  classification: TabEntryClassification
  id: string
}

function tabEntryActionOptionId(classification: TabEntryActionClassification): string {
  switch (classification.kind) {
    case 'existing-file':
    case 'new-file':
      return `${classification.kind}:${classification.relativePath}`
    case 'absolute-file':
      return `${classification.kind}:${classification.filePath}`
    case 'explicit-url':
    case 'host-url':
      return `${classification.kind}:${classification.url}`
    case 'search':
      return `search:${classification.query}`
  }
}

function emptyOption(): TabEntryOption {
  return {
    id: 'empty',
    // Why shared: the empty status row and the input placeholder describe the
    // same list, and drifting copy makes the omnibox look like two surfaces.
    classification: { kind: 'empty', message: getTabEntryOmniboxPlaceholder() }
  }
}

function blockedOption(id: string, message: string): TabEntryOption {
  return { id, classification: { kind: 'blocked', message } }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function invalidPathOption(error: unknown): TabEntryOption {
  return blockedOption('invalid-path', errorMessage(error))
}

function fileListStatusOption(fileList: RuntimeFileListState): TabEntryOption | null {
  if (fileList.loading) {
    return blockedOption(
      'loading',
      translate(
        'auto.components.tab.bar.tab.create.entry.classifier.097a982ee0',
        'Loading files...'
      )
    )
  }
  return fileList.loadError ? blockedOption('load-error', fileList.loadError) : null
}

function clampActionLimit(limit: number): number {
  return Number.isFinite(limit) ? Math.max(0, Math.floor(limit)) : 0
}

function toOptions(
  classifications: TabEntryActionClassification[],
  limit: number,
  status?: TabEntryOption | null
): TabEntryOption[] {
  const options: TabEntryOption[] = classifications
    .slice(0, clampActionLimit(limit))
    .map((classification) => ({
      id: tabEntryActionOptionId(classification),
      classification
    }))
  if (status) {
    options.push(status)
  }
  return options
}

export function classifyTabEntryQuery(
  query: string,
  fileList: RuntimeFileListState,
  context: TabEntryOptionsContext = {}
): TabEntryClassification {
  return (
    getTabEntryOptions(query, fileList, 1, context)[0]?.classification ??
    emptyOption().classification
  )
}

export function getTabEntryOptions(
  query: string,
  fileList: RuntimeFileListState,
  limit = 4,
  context: TabEntryOptionsContext = {}
): TabEntryOption[] {
  if (isQuickOpenQueryTooLarge(query)) {
    return [
      blockedOption(
        'query-too-large',
        translate(
          'auto.components.tab.bar.tab.create.entry.classifier.queryTooLarge',
          'Search text is too large.'
        )
      )
    ]
  }

  const parsedSearch = parseForcedSearchQuery(query)
  const trimmed = parsedSearch.query
  const engine = context.searchEngine ?? DEFAULT_SEARCH_ENGINE
  const search: TabEntryActionClassification = { kind: 'search', engine, query: trimmed }
  if (parsedSearch.forced) {
    return trimmed ? toOptions([search], limit) : [emptyOption()]
  }
  if (!trimmed) {
    return [emptyOption()]
  }

  if (isTabEntryAbsolutePathLike(trimmed)) {
    if (!context.allowAbsolutePaths) {
      return [
        blockedOption(
          'absolute-path-blocked',
          translate(
            'auto.components.tab.bar.tab.create.entry.classifier.absolutePathRemoteBlocked',
            'Absolute paths require a local workspace.'
          )
        )
      ]
    }
    try {
      const filePath = validateNewTabEntryAbsolutePath(trimmed, context.localPlatform)
      return toOptions([{ kind: 'absolute-file', filePath }], limit)
    } catch (error) {
      return [blockedOption('invalid-absolute-path', errorMessage(error))]
    }
  }

  const explicitUrl = classifyExplicitUrl(trimmed)
  if (explicitUrl) {
    return explicitUrl.kind === 'blocked'
      ? [blockedOption('invalid-url', explicitUrl.message)]
      : toOptions([explicitUrl], limit)
  }

  const hostUrl = classifyHostUrl(trimmed)
  let newFile: TabEntryActionClassification | null = null
  let pathError: unknown = null
  try {
    newFile = { kind: 'new-file', relativePath: validateNewTabEntryRelativePath(trimmed) }
  } catch (error) {
    pathError = error
  }

  const fileStatus = fileListStatusOption(fileList)
  if (fileStatus) {
    if (hostUrl?.kind === 'blocked') {
      return [fileStatus]
    }
    if (hostUrl?.kind === 'host-url') {
      return toOptions([hostUrl], limit, fileStatus)
    }
    // Why: path-shaped text waits on the scan whether or not it is creatable, so
    // "src/" reports the scan instead of flashing a path error it will not keep.
    if (isLikelyNewFileIntent(trimmed)) {
      return [fileStatus]
    }
    if (pathError) {
      return [invalidPathOption(pathError)]
    }
    return toOptions([search], limit, fileStatus)
  }

  const actionLimit = clampActionLimit(limit)
  const existingFiles = findExistingFileMatches(
    trimmed,
    getPreparedQuickOpenFiles(fileList.files),
    Math.max(actionLimit, 1)
  )
  const exactExistingFiles = existingFiles.filter((file) => file.matchKind !== 'fuzzy')
  const fuzzyExistingFiles = existingFiles.filter((file) => file.matchKind === 'fuzzy')

  if (exactExistingFiles.length > 0) {
    const options: TabEntryActionClassification[] = [...exactExistingFiles]
    if (hostUrl?.kind === 'host-url') {
      options.push(hostUrl)
    } else if (!hostUrl && newFile) {
      options.push(search)
    }
    return toOptions(options, actionLimit)
  }
  if (hostUrl?.kind === 'blocked') {
    return [blockedOption('invalid-url', hostUrl.message)]
  }
  if (hostUrl?.kind === 'host-url') {
    return toOptions([hostUrl, ...fuzzyExistingFiles], actionLimit)
  }
  if (pathError || !newFile) {
    // Why: an unusable path is still a live quick-open prefix — "src/" cannot be
    // created, but it matches real files, and dropping them turns every typed
    // separator into an error row mid-keystroke.
    return fuzzyExistingFiles.length > 0
      ? toOptions(fuzzyExistingFiles, actionLimit)
      : [invalidPathOption(pathError)]
  }
  if (isLikelyNewFileIntent(trimmed)) {
    return toOptions([newFile, search, ...fuzzyExistingFiles], actionLimit)
  }
  // Why no create row: a spaced, extension-less phrase is a web query, and a
  // stray arrow/click on "Create file" leaves an empty `release notes` on disk
  // that then outranks search as an exact match forever after.
  if (/\s/.test(trimmed)) {
    return toOptions([search, ...fuzzyExistingFiles], actionLimit)
  }
  // Why: a single token is still a quick-open attempt ("btn" → Button.tsx), so
  // only phrases promote web search over fuzzy matches. Fuzzy matching is a
  // subsequence scan that fills every slot in a real repo, so hold one back —
  // otherwise search silently disappears from the list it should always offer.
  return toOptions(
    [...fuzzyExistingFiles.slice(0, Math.max(actionLimit - 1, 1)), search, newFile],
    actionLimit
  )
}
