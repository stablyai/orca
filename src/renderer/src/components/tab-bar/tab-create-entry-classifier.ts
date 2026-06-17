import {
  prepareQuickOpenFiles,
  rankQuickOpenFiles,
  type QuickOpenIndexedFile
} from '../quick-open-search'
import type { RuntimeFileListState } from '../quick-open-file-list'
import { translate } from '@/i18n/i18n'

const HOST_FILE_EXTENSIONS = new Set([
  'css',
  'html',
  'js',
  'jsx',
  'json',
  'md',
  'py',
  'toml',
  'ts',
  'tsx',
  'yaml',
  'yml'
])
const LOCAL_ADDRESS_PATTERN =
  /^(?:localhost|127(?:\.\d{1,3}){3}|0\.0\.0\.0|\[[0-9a-f:]+\])(?::\d+)?(?:[/?#].*)?$/i

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

function normalizeFileMatchQuery(query: string): string {
  return query.trim().replace(/\\/g, '/')
}

function hasPathSeparator(query: string): boolean {
  return /[\\/]/.test(query)
}

function hasFilenameExtension(query: string): boolean {
  return /(?:^|[\\/])[^\\/]+\.[^\\/]+$/.test(query.trim())
}

function isLikelyNewFileIntent(query: string): boolean {
  return hasPathSeparator(query) || hasFilenameExtension(query)
}

function dedupeMatches(matches: ExistingFileMatch[]): ExistingFileMatch[] {
  const seen = new Set<string>()
  return matches.filter((match) => {
    if (seen.has(match.relativePath)) {
      return false
    }
    seen.add(match.relativePath)
    return true
  })
}

type ExistingFileMatch = Extract<TabEntryActionClassification, { kind: 'existing-file' }>

function findExistingFileMatches(
  query: string,
  indexedFiles: readonly QuickOpenIndexedFile[],
  limit: number
): ExistingFileMatch[] {
  const normalizedQuery = normalizeFileMatchQuery(query)
  if (!normalizedQuery || limit <= 0) {
    return []
  }
  const lowerQuery = normalizedQuery.toLowerCase()
  const exactPathMatches = indexedFiles
    .filter((file) => file.lowerPath === lowerQuery)
    .map((file) => ({
      kind: 'existing-file' as const,
      matchKind: 'exact-path' as const,
      relativePath: file.path
    }))
  const exactBasenameMatches = indexedFiles
    .filter((file) => file.lowerFilename === lowerQuery)
    .map((file) => ({
      kind: 'existing-file' as const,
      matchKind: 'exact-basename' as const,
      relativePath: file.path
    }))
  const fuzzyMatches = rankQuickOpenFiles(normalizedQuery, indexedFiles, limit).map((file) => ({
    kind: 'existing-file' as const,
    matchKind: 'fuzzy' as const,
    relativePath: file.path
  }))

  return dedupeMatches([...exactPathMatches, ...exactBasenameMatches, ...fuzzyMatches]).slice(
    0,
    limit
  )
}

function classifyExplicitUrl(
  query: string
): Extract<TabEntryClassification, { kind: 'blocked' | 'explicit-url' }> | null {
  if (LOCAL_ADDRESS_PATTERN.test(query)) {
    return null
  }
  let url: URL
  try {
    url = new URL(query)
  } catch {
    return null
  }
  if ((url.protocol !== 'http:' && url.protocol !== 'https:') || !url.hostname) {
    return {
      kind: 'blocked',
      message: translate(
        'auto.components.tab.bar.tab.create.entry.classifier.90eb94dc48',
        'Enter an http:// or https:// URL.'
      )
    }
  }
  return { kind: 'explicit-url', url: url.href }
}

function classifyLocalDevUrl(
  query: string
): Extract<TabEntryActionClassification, { kind: 'host-url' }> | null {
  if (!LOCAL_ADDRESS_PATTERN.test(query)) {
    return null
  }
  try {
    const url = new URL(`http://${query}`)
    return url.hostname ? { kind: 'host-url', url: url.href } : null
  } catch {
    return null
  }
}

function classifyHostLikeUrl(
  query: string
): Extract<TabEntryActionClassification, { kind: 'host-url' }> | null {
  if (/[\\/]/.test(query) || /\s/.test(query)) {
    return null
  }
  const extension = query.split(':')[0]?.split('.').pop()?.toLowerCase() ?? ''
  if (HOST_FILE_EXTENSIONS.has(extension)) {
    return null
  }
  const hostPort = '(?::\\d{1,5})?'
  const localhost = new RegExp(`^localhost${hostPort}$`, 'i')
  const ipv4 = new RegExp(`^(?:\\d{1,3}\\.){3}\\d{1,3}${hostPort}$`)
  const domain = new RegExp(
    `^(?=.{1,253}${hostPort}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\\.)+[a-z]{2,}${hostPort}$`,
    'i'
  )
  if (!localhost.test(query) && !ipv4.test(query) && !domain.test(query)) {
    return null
  }
  try {
    const url = new URL(`https://${query}`)
    return url.hostname ? { kind: 'host-url', url: url.href } : null
  } catch {
    return null
  }
}

export function validateNewTabEntryRelativePath(query: string): string {
  const trimmed = query.trim()
  if (!trimmed) {
    throw new Error('Enter a URL or file path.')
  }
  if (Array.from(trimmed).some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)) {
    throw new Error('File paths cannot contain control characters.')
  }
  if (trimmed.startsWith('/')) {
    throw new Error('Enter a relative file path.')
  }
  if (/^[A-Za-z]:/.test(trimmed)) {
    throw new Error('Windows drive paths are not supported here.')
  }
  if (/^[\\/]{2}/.test(trimmed)) {
    throw new Error('UNC paths are not supported here.')
  }
  if (trimmed === '~' || trimmed.startsWith('~/') || trimmed.startsWith('~\\')) {
    throw new Error('Home-relative paths are not supported here.')
  }
  if (/[\\/]$/.test(trimmed)) {
    throw new Error('Enter a file path, not a directory path.')
  }
  if (trimmed.split(/[\\/]/).some((segment) => segment.length === 0)) {
    throw new Error('File paths cannot contain empty segments.')
  }

  const normalized = trimmed.replace(/\\/g, '/')
  const segments = normalized.split('/')
  if (segments.some((segment) => segment === '.' || segment === '..')) {
    throw new Error('File paths cannot contain . or .. segments.')
  }
  if (segments.some((segment) => segment === '~')) {
    throw new Error('File paths cannot contain ~ segments.')
  }
  return normalized
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

  const hostUrl = classifyLocalDevUrl(trimmed) ?? classifyHostLikeUrl(trimmed)

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
