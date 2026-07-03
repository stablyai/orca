import { isQuickOpenQueryTooLarge, prepareQuickOpenFiles } from '../quick-open-search'
import type { RuntimeFileListState } from '../quick-open-file-list'
import { translate } from '@/i18n/i18n'
import { findExistingFileMatches, isLikelyNewFileIntent } from './tab-create-entry-file-matches'
import { validateNewTabEntryRelativePath } from './tab-create-entry-path-validation'
import { classifyExplicitUrl, classifyHostUrl } from './tab-create-entry-url-classification'

export { validateNewTabEntryRelativePath } from './tab-create-entry-path-validation'

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
  | { kind: 'blocked'; message: string }

export type TabEntryActionClassification = Exclude<
  TabEntryClassification,
  { kind: 'blocked' | 'empty' }
>

export type TabEntryOption = {
  classification: TabEntryClassification
  id: string
}

export function classifyTabEntryQuery(
  query: string,
  fileList: RuntimeFileListState
): TabEntryClassification {
  return (
    getTabEntryOptions(query, fileList, 1)[0]?.classification ?? {
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
  limit = 4
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
      id:
        classification.kind === 'existing-file'
          ? `${classification.kind}:${classification.relativePath}`
          : classification.kind === 'new-file'
            ? `${classification.kind}:${classification.relativePath}`
            : `${classification.kind}:${classification.url}`,
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
