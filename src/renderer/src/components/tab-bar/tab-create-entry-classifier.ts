import {
  prepareQuickOpenFiles,
  rankQuickOpenFiles,
  type QuickOpenIndexedFile
} from '../quick-open-search'
import type { RuntimeFileListState } from '../quick-open-file-list'

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

export type TabEntryClassification =
  | { kind: 'empty'; message: string }
  | { kind: 'explicit-url'; url: string }
  | { kind: 'existing-file'; relativePath: string }
  | { kind: 'host-url'; url: string }
  | { kind: 'new-file'; relativePath: string }
  | { kind: 'blocked'; message: string }

function normalizeFileMatchQuery(query: string): string {
  return query.trim().replace(/\\/g, '/')
}

function findExistingFileMatch(
  query: string,
  indexedFiles: readonly QuickOpenIndexedFile[]
): string | null {
  const normalizedQuery = normalizeFileMatchQuery(query)
  if (!normalizedQuery) {
    return null
  }
  const lowerQuery = normalizedQuery.toLowerCase()
  const exactPath = indexedFiles.find((file) => file.lowerPath === lowerQuery)
  if (exactPath) {
    return exactPath.path
  }
  const exactBasename = indexedFiles.find((file) => file.lowerFilename === lowerQuery)
  if (exactBasename) {
    return exactBasename.path
  }
  return rankQuickOpenFiles(normalizedQuery, indexedFiles, 1)[0]?.path ?? null
}

function classifyExplicitUrl(query: string): TabEntryClassification | null {
  let url: URL
  try {
    url = new URL(query)
  } catch {
    return null
  }
  if ((url.protocol !== 'http:' && url.protocol !== 'https:') || !url.hostname) {
    return { kind: 'blocked', message: 'Enter an http:// or https:// URL.' }
  }
  return { kind: 'explicit-url', url: url.href }
}

function classifyHostLikeUrl(query: string): TabEntryClassification | null {
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
  const trimmed = query.trim()
  if (!trimmed) {
    return { kind: 'empty', message: 'Enter a URL or file path.' }
  }

  const explicitUrl = classifyExplicitUrl(trimmed)
  if (explicitUrl) {
    return explicitUrl
  }

  if (fileList.loading) {
    return { kind: 'blocked', message: 'Loading files...' }
  }
  if (fileList.loadError) {
    return { kind: 'blocked', message: fileList.loadError }
  }

  const existingFile = findExistingFileMatch(trimmed, prepareQuickOpenFiles(fileList.files))
  if (existingFile) {
    return { kind: 'existing-file', relativePath: existingFile }
  }

  const hostUrl = classifyHostLikeUrl(trimmed)
  if (hostUrl) {
    return hostUrl
  }

  try {
    return { kind: 'new-file', relativePath: validateNewTabEntryRelativePath(trimmed) }
  } catch (error) {
    return {
      kind: 'blocked',
      message: error instanceof Error ? error.message : String(error)
    }
  }
}
