import { isQuickOpenQueryTooLarge, prepareQuickOpenFiles } from '../quick-open-search'
import type { RuntimeFileListState } from '../quick-open-file-list'
import { translate } from '@/i18n/i18n'
import { findExistingFileMatches, isLikelyNewFileIntent } from './tab-create-entry-file-matches'
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
  }
}

export function classifyTabEntryQuery(
  query: string,
  fileList: RuntimeFileListState,
  context: TabEntryOptionsContext = {}
): TabEntryClassification {
  return (
    getTabEntryOptions(query, fileList, 1, context)[0]?.classification ?? {
      kind: 'empty',
      message: translate(
        'auto.components.tab.bar.tab.create.entry.classifier.5553b283ce',
        'Enter a URL or file path.'
      )
    }
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
      {
        id: 'query-too-large',
        classification: {
          kind: 'blocked',
          message: translate(
            'auto.components.tab.bar.tab.create.entry.classifier.queryTooLarge',
            'Search text is too large.'
          )
        }
      }
    ]
  }

  const trimmed = query.trim()
  if (!trimmed) {
    return [
      {
        id: 'empty',
        classification: {
          kind: 'empty',
          message: translate(
            'auto.components.tab.bar.tab.create.entry.classifier.5a9c83c04b',
            'Open any file, URL, agent, ...'
          )
        }
      }
    ]
  }

  if (isTabEntryAbsolutePathLike(trimmed)) {
    if (!context.allowAbsolutePaths) {
      return [
        {
          id: 'absolute-path-blocked',
          classification: {
            kind: 'blocked',
            message: translate(
              'auto.components.tab.bar.tab.create.entry.classifier.absolutePathRemoteBlocked',
              'Absolute paths require a local workspace.'
            )
          }
        }
      ]
    }
    try {
      const filePath = validateNewTabEntryAbsolutePath(trimmed, context.localPlatform)
      return [
        {
          id: `absolute-file:${filePath}`,
          classification: { kind: 'absolute-file', filePath }
        }
      ]
    } catch (error) {
      return [
        {
          id: 'invalid-absolute-path',
          classification: {
            kind: 'blocked',
            message: error instanceof Error ? error.message : String(error)
          }
        }
      ]
    }
  }

  const explicitUrl = classifyExplicitUrl(trimmed)
  if (explicitUrl) {
    return [
      {
        id: explicitUrl.kind === 'blocked' ? 'invalid-url' : `url:${explicitUrl.url}`,
        classification: explicitUrl
      }
    ]
  }

  if (fileList.loading) {
    return [
      {
        id: 'loading',
        classification: {
          kind: 'blocked',
          message: translate(
            'auto.components.tab.bar.tab.create.entry.classifier.097a982ee0',
            'Loading files...'
          )
        }
      }
    ]
  }
  if (fileList.loadError) {
    return [{ id: 'load-error', classification: { kind: 'blocked', message: fileList.loadError } }]
  }
  const existingFiles = findExistingFileMatches(
    trimmed,
    prepareQuickOpenFiles(fileList.files),
    Math.max(limit, 1)
  )
  const exactExistingFiles = existingFiles.filter((file) => file.matchKind !== 'fuzzy')
  const fuzzyExistingFiles = existingFiles.filter((file) => file.matchKind === 'fuzzy')

  let newFile: TabEntryActionClassification | null = null
  try {
    newFile = { kind: 'new-file', relativePath: validateNewTabEntryRelativePath(trimmed) }
  } catch {
    newFile = null
  }

  const hostUrl = classifyHostUrl(trimmed)

  const options: TabEntryActionClassification[] = []
  if (exactExistingFiles.length > 0) {
    options.push(...exactExistingFiles)
    if (hostUrl) {
      options.push(hostUrl)
    }
  } else if (hostUrl) {
    options.push(hostUrl)
    options.push(...fuzzyExistingFiles)
  } else if (newFile && isLikelyNewFileIntent(trimmed)) {
    options.push(newFile, ...fuzzyExistingFiles)
  } else {
    options.push(...fuzzyExistingFiles)
    if (newFile) {
      options.push(newFile)
    }
  }

  if (options.length > 0) {
    return options.slice(0, limit).map((classification) => ({
      id: tabEntryActionOptionId(classification),
      classification
    }))
  }

  try {
    validateNewTabEntryRelativePath(trimmed)
  } catch (error) {
    return [
      {
        id: 'invalid-path',
        classification: {
          kind: 'blocked',
          message: error instanceof Error ? error.message : String(error)
        }
      }
    ]
  }

  return [
    {
      id: 'blocked',
      classification: {
        kind: 'blocked',
        message: translate(
          'auto.components.tab.bar.tab.create.entry.classifier.42e6262ae9',
          'No action available.'
        )
      }
    }
  ]
}
