/* eslint-disable max-lines -- Why: this parser keeps massCode scanning, path normalization, and write serialization in one audited boundary. */
import type { MassCodeSnippet, MassCodeFolder } from '../../../shared/types'

/**
 * massCode v5+ Markdown Vault structure:
 * - Root folders define types: code, notes, http.
 * - Each type folder contains user folders or .masscode/inbox.
 * - Snippets are .md files with YAML frontmatter.
 * - Type-specific state lives in [Type]/.masscode/state.json.
 */

export type MassCodeType = 1 | 2 | 3 | 4 | 5

export type MassCodeExtendedSnippet = MassCodeSnippet & {
  isFavorite: boolean
  isTrash: boolean
  type: MassCodeType
  inInbox: boolean
}

export type MassCodeData = {
  snippets: MassCodeExtendedSnippet[]
  folders: MassCodeFolder[]
  tags: string[]
  truncated: boolean
  warnings: string[]
}

type MassCodeDirEntry = {
  name: string
  isDirectory: boolean
  isSymlink?: boolean
}

type ParsedSnippet = {
  snippet: MassCodeSnippet
  metadata: Record<string, unknown>
}

const TYPE_MAP: Record<string, MassCodeType> = {
  code: 1,
  notes: 2,
  http: 3,
  math: 4,
  tools: 5
}

const TYPE_DIRECTORY_BY_ID: Record<MassCodeType, string> = {
  1: 'code',
  2: 'notes',
  3: 'http',
  4: 'math',
  5: 'tools'
}

export const MASSCODE_SCAN_LIMITS = {
  maxDirectories: 2_000,
  maxSnippets: 2_000,
  maxDepth: 12,
  maxSnippetBytes: 256 * 1024
} as const

export function normalizeMassCodePreviewLines(value: unknown): 0 | 1 | 2 {
  return value === 0 || value === 1 || value === 2 ? value : 1
}

export function normalizeMassCodePathForMatch(pathValue: string): string {
  return pathValue.replaceAll('\\', '/').replace(/\/+/g, '/').replace(/\/$/, '').toLowerCase()
}

function trimTrailingPathSeparators(pathValue: string): string {
  return pathValue.replace(/[\\/]+$/, '')
}

function getPathSeparator(pathValue: string): '/' | '\\' {
  return pathValue.includes('\\') && !pathValue.includes('/') ? '\\' : '/'
}

function joinMassCodePath(basePath: string, ...segments: string[]): string {
  const separator = getPathSeparator(basePath)
  return [trimTrailingPathSeparators(basePath), ...segments].filter(Boolean).join(separator)
}

function getPathBasename(filePath: string): string {
  return filePath.split(/[\\/]/).pop() ?? ''
}

function getRelativePathSegments(vaultPath: string, fullPath: string): string[] {
  const normalizedVaultPath = normalizeMassCodePathForMatch(vaultPath)
  const normalizedFullPath = normalizeMassCodePathForMatch(fullPath)
  if (normalizedFullPath === normalizedVaultPath) {
    return []
  }
  const vaultPrefix = `${normalizedVaultPath}/`
  if (!normalizedFullPath.startsWith(vaultPrefix)) {
    return []
  }
  return normalizedFullPath.slice(vaultPrefix.length).split('/').filter(Boolean)
}

function isMassCodePathInsideVault(vaultPath: string, candidatePath: string): boolean {
  const normalizedVaultPath = normalizeMassCodePathForMatch(vaultPath)
  const normalizedCandidatePath = normalizeMassCodePathForMatch(candidatePath)
  return (
    normalizedCandidatePath === normalizedVaultPath ||
    normalizedCandidatePath.startsWith(`${normalizedVaultPath}/`)
  )
}

function isMassCodeTypeRootPath(vaultPath: string, candidatePath: string): boolean {
  const pathSegments = getRelativePathSegments(vaultPath, candidatePath)
  return pathSegments.length === 1 && TYPE_MAP[pathSegments[0]?.toLowerCase() ?? ''] !== undefined
}

function parseTruthyFlag(value: unknown): boolean {
  if (typeof value === 'boolean') {
    return value
  }
  if (typeof value === 'number') {
    return value === 1
  }
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase()
    return normalized === '1' || normalized === 'true' || normalized === 'yes'
  }
  return false
}

function getMetadataValueCaseInsensitive(
  metadata: Record<string, unknown>,
  keys: string[]
): unknown {
  const lookup = new Map(Object.entries(metadata).map(([key, value]) => [key.toLowerCase(), value]))
  for (const key of keys) {
    const value = lookup.get(key.toLowerCase())
    if (value !== undefined) {
      return value
    }
  }
  return undefined
}

function readStringMetadata(metadata: Record<string, unknown>, key: string): string | null {
  const value = getMetadataValueCaseInsensitive(metadata, [key])
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function readTagsMetadata(metadata: Record<string, unknown>): string[] {
  const value = getMetadataValueCaseInsensitive(metadata, ['tags'])
  if (!Array.isArray(value)) {
    return []
  }
  return value.filter((tag): tag is string => typeof tag === 'string' && tag.trim().length > 0)
}

function readTimestampMetadata(metadata: Record<string, unknown>, key: string): number {
  const value = getMetadataValueCaseInsensitive(metadata, [key])
  const timestamp = Number(value)
  return Number.isFinite(timestamp) && timestamp > 0 ? timestamp : Date.now()
}

export async function fetchMassCodeData(vaultPath: string): Promise<MassCodeData> {
  const folders: MassCodeFolder[] = []
  const snippets: MassCodeExtendedSnippet[] = []
  const tagsSet = new Set<string>()
  const warnings = new Set<string>()
  const visitedDirectories = new Set<string>()
  let directoryCount = 0
  let truncated = false

  async function walk(
    currentPath: string,
    parentId: string | null = null,
    currentType: MassCodeType | null = null,
    depth = 0
  ): Promise<void> {
    if (truncated) {
      return
    }
    if (depth > MASSCODE_SCAN_LIMITS.maxDepth) {
      truncated = true
      warnings.add('Stopped scanning because the vault is nested too deeply.')
      return
    }

    const normalizedCurrentPath = normalizeMassCodePathForMatch(currentPath)
    if (visitedDirectories.has(normalizedCurrentPath)) {
      return
    }
    visitedDirectories.add(normalizedCurrentPath)
    directoryCount += 1
    if (directoryCount > MASSCODE_SCAN_LIMITS.maxDirectories) {
      truncated = true
      warnings.add('Stopped scanning after the directory limit was reached.')
      return
    }

    let entries: MassCodeDirEntry[]
    try {
      entries = await window.api.fs.readDir({ dirPath: currentPath })
    } catch (error) {
      if (depth === 0) {
        throw error
      }
      warnings.add(`Skipped unreadable folder: ${currentPath}`)
      return
    }

    for (const entry of entries) {
      if (truncated || snippets.length >= MASSCODE_SCAN_LIMITS.maxSnippets) {
        truncated = true
        warnings.add('Stopped scanning after the snippet limit was reached.')
        return
      }

      const fullPath = joinMassCodePath(currentPath, entry.name)
      const normalizedFullPath = normalizeMassCodePathForMatch(fullPath)
      const pathSegments = getRelativePathSegments(vaultPath, fullPath)
      let detectedType = currentType
      if (!detectedType && pathSegments.length > 0) {
        detectedType = TYPE_MAP[pathSegments[0]?.toLowerCase() ?? '']
      }

      if (entry.isDirectory) {
        if (entry.isSymlink) {
          warnings.add(`Skipped symlinked folder: ${fullPath}`)
          continue
        }
        if (entry.name.startsWith('.') && entry.name !== '.masscode') {
          continue
        }

        const folderNameLower = entry.name.toLowerCase()
        const isRootTypeFolder =
          normalizedCurrentPath === normalizeMassCodePathForMatch(vaultPath) &&
          TYPE_MAP[folderNameLower] !== undefined
        const isSystemDir =
          folderNameLower === '.masscode' ||
          folderNameLower === 'inbox' ||
          folderNameLower === 'trash'

        const folderId = fullPath
        if (!isRootTypeFolder && !isSystemDir) {
          folders.push({
            id: folderId,
            name: entry.name,
            parentId:
              normalizedCurrentPath === normalizeMassCodePathForMatch(vaultPath) ||
              isMassCodeTypeRootPath(vaultPath, currentPath)
                ? null
                : parentId
          })
        }

        await walk(
          fullPath,
          isSystemDir || isRootTypeFolder ? parentId : folderId,
          detectedType,
          depth + 1
        )
      } else if (entry.name.toLowerCase().endsWith('.md')) {
        try {
          const stats = await window.api.fs.stat({ filePath: fullPath })
          if (stats.size > MASSCODE_SCAN_LIMITS.maxSnippetBytes) {
            warnings.add(`Skipped large snippet: ${fullPath}`)
            continue
          }
          const { content } = await window.api.fs.readFile({ filePath: fullPath })
          const parsed = parseSnippet(content, fullPath, parentId)
          if (parsed) {
            const isTrash = normalizedFullPath.includes('/trash/')
            const inInbox = normalizedFullPath.includes('/inbox/')

            // Why: massCode vaults in the wild mix naming/casing and string booleans.
            const favoriteValue = getMetadataValueCaseInsensitive(parsed.metadata, [
              'isFavorites',
              'isFavorite',
              'favorited',
              'favorite'
            ])
            const isFavorite = parseTruthyFlag(favoriteValue)

            const extendedSnippet: MassCodeExtendedSnippet = {
              ...parsed.snippet,
              type: detectedType || 1,
              isFavorite,
              isTrash,
              inInbox
            }
            snippets.push(extendedSnippet)
            parsed.snippet.tags.forEach((tag) => tagsSet.add(tag))
          }
        } catch {
          warnings.add(`Skipped unreadable snippet: ${fullPath}`)
        }
      }
    }
  }

  await walk(vaultPath)
  return {
    snippets,
    folders,
    tags: Array.from(tagsSet).sort(),
    truncated,
    warnings: Array.from(warnings)
  }
}

function parseSnippet(
  rawContent: string,
  filePath: string,
  folderId: string | null
): ParsedSnippet | null {
  const frontmatterRegex = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/
  const match = rawContent.match(frontmatterRegex)

  if (!match) {
    const name = getPathBasename(filePath).replace(/\.md$/i, '') || 'Untitled'
    return {
      metadata: {},
      snippet: {
        id: filePath,
        name,
        content: rawContent,
        language: 'markdown',
        tags: [],
        folderId,
        createdAt: Date.now(),
        updatedAt: Date.now()
      }
    }
  }

  const metadata = parseFrontmatterMetadata(match[1] ?? '')
  const content = match[2] ?? ''
  const fallbackName = getPathBasename(filePath).replace(/\.md$/i, '') || 'Untitled'

  return {
    metadata,
    snippet: {
      id: filePath,
      name: readStringMetadata(metadata, 'name') ?? fallbackName,
      content: content.trim(),
      language: readStringMetadata(metadata, 'language') ?? 'markdown',
      tags: readTagsMetadata(metadata),
      // Why: folder assignment comes from the vault filesystem path; frontmatter
      // can be stale and must not re-parent snippets in the UI.
      folderId,
      createdAt: readTimestampMetadata(metadata, 'createdAt'),
      updatedAt: readTimestampMetadata(metadata, 'updatedAt')
    }
  }
}

function parseFrontmatterMetadata(yaml: string): Record<string, unknown> {
  const metadata: Record<string, unknown> = {}
  for (const line of yaml.split(/\r?\n/)) {
    const separatorIndex = line.indexOf(':')
    if (separatorIndex <= 0) {
      continue
    }
    const key = line.slice(0, separatorIndex).trim()
    const value = line.slice(separatorIndex + 1).trim()
    if (key) {
      metadata[key] = parseFrontmatterValue(value)
    }
  }
  return metadata
}

function parseFrontmatterValue(value: string): unknown {
  if (value.startsWith('[') && value.endsWith(']')) {
    return value
      .slice(1, -1)
      .split(',')
      .map((entry) => unquoteFrontmatterString(entry.trim()))
      .filter(Boolean)
  }
  return unquoteFrontmatterString(value)
}

function unquoteFrontmatterString(value: string): string {
  const trimmed = value.trim()
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1)
  }
  return trimmed
}

export function sanitizeMassCodeSnippetFileName(name: string): string {
  const sanitized = name
    .trim()
    .split('')
    .map((character) =>
      character.charCodeAt(0) < 32 || '<>:"/\\|?*'.includes(character) ? '-' : character
    )
    .join('')
    .replace(/^\.+/g, '')
    .replace(/\.+$/g, '')
    .slice(0, 120)
    .trim()
  return sanitized || 'Untitled'
}

export function getMassCodeSnippetFilePath({
  vaultPath,
  selectedFolderId,
  selectedType,
  snippetName
}: {
  vaultPath: string
  selectedFolderId: string | null
  selectedType: MassCodeType
  snippetName: string | null | undefined
}): string {
  const basePath =
    selectedFolderId && isMassCodePathInsideVault(vaultPath, selectedFolderId)
      ? selectedFolderId
      : joinMassCodePath(vaultPath, TYPE_DIRECTORY_BY_ID[selectedType])
  return joinMassCodePath(
    basePath,
    `${sanitizeMassCodeSnippetFileName(snippetName || 'Untitled')}.md`
  )
}

function formatYamlString(value: string): string {
  return JSON.stringify(value)
}

export async function writeMassCodeSnippet(
  filePath: string,
  snippet: Partial<MassCodeExtendedSnippet>
): Promise<void> {
  const name = snippet.name || 'Untitled'
  const language = snippet.language || 'markdown'
  const tags = snippet.tags || []
  const createdAt = snippet.createdAt || Date.now()
  const updatedAt = Date.now()
  const content = snippet.content || ''

  const frontmatter = [
    '---',
    `name: ${formatYamlString(name)}`,
    `language: ${formatYamlString(language)}`,
    `tags: [${tags.map(formatYamlString).join(', ')}]`,
    `createdAt: ${createdAt}`,
    `updatedAt: ${updatedAt}`,
    '---',
    content
  ].join('\n')

  await window.api.fs.writeFile({ filePath, content: frontmatter })
}
