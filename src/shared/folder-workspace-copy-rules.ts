export const DEFAULT_FOLDER_WORKSPACE_COPY_IGNORE_PATTERNS = [
  '.git/',
  '.hg/',
  '.svn/',
  'node_modules/',
  'bower_components/',
  '.pnpm-store/',
  '.yarn/cache/',
  '.yarn/unplugged/',
  '.next/',
  '.nuxt/',
  '.expo/',
  '.cache/',
  '.angular/',
  '.parcel-cache/',
  '.turbo/',
  '.vite/',
  'dist/',
  'build/',
  'out/',
  '.serverless/',
  '.aws-sam/',
  'coverage/',
  'target/',
  '.gradle/',
  'Pods/',
  'DerivedData/',
  '.venv/',
  'venv/',
  '__pycache__/',
  '.pytest_cache/',
  '.mypy_cache/',
  '.ruff_cache/',
  '.tox/',
  '.DS_Store'
]

export function parseFolderWorkspaceCopyIgnoreFile(content: string): string[] {
  return content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#') && !line.startsWith('!'))
}

export function shouldExcludeFolderWorkspaceCopyPath(args: {
  relativePath: string
  isDirectory: boolean
  ignorePatterns: readonly string[]
}): boolean {
  const relativePath = normalizeRelativePath(args.relativePath)
  if (!relativePath) {
    return false
  }
  return args.ignorePatterns.some((pattern) =>
    doesIgnorePatternMatchPath(pattern, relativePath, args.isDirectory)
  )
}

function doesIgnorePatternMatchPath(
  rawPattern: string,
  relativePath: string,
  isDirectory: boolean
): boolean {
  const parsed = parseIgnorePattern(rawPattern)
  if (!parsed) {
    return false
  }

  if (parsed.hasSlash) {
    const matchesSelf = wildcardSegmentPathMatches(parsed.pattern, relativePath)
    if (!parsed.directoryOnly) {
      return matchesSelf
    }
    const parentSegments = relativePath.split('/').slice(0, -1)
    return (
      matchesSelf ||
      parentSegments.some((_, index) =>
        wildcardSegmentPathMatches(parsed.pattern, parentSegments.slice(0, index + 1).join('/'))
      ) ||
      (isDirectory && wildcardSegmentPathMatches(parsed.pattern, relativePath))
    )
  }

  const segments = relativePath.split('/')
  if (parsed.rootOnly) {
    if (parsed.directoryOnly) {
      return wildcardSegmentMatches(parsed.pattern, segments[0] ?? '')
    }
    return segments.length === 1 && wildcardSegmentMatches(parsed.pattern, segments[0] ?? '')
  }
  if (parsed.directoryOnly) {
    return segments.some((segment, index) => {
      if (!wildcardSegmentMatches(parsed.pattern, segment)) {
        return false
      }
      return isDirectory || index < segments.length - 1
    })
  }
  return wildcardSegmentMatches(parsed.pattern, segments.at(-1) ?? '')
}

function parseIgnorePattern(
  rawPattern: string
): { pattern: string; directoryOnly: boolean; hasSlash: boolean; rootOnly: boolean } | null {
  const trimmed = rawPattern.trim()
  if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('!')) {
    return null
  }
  const normalized = normalizeRelativePath(trimmed.replace(/^\.\//, ''))
  const rootOnly = trimmed.startsWith('/')
  const withoutLeadingSlash = normalized.replace(/^\/+/, '')
  const directoryOnly = withoutLeadingSlash.endsWith('/')
  const pattern = withoutLeadingSlash.replace(/^\/+|\/+$/g, '')
  if (!pattern) {
    return null
  }
  return {
    pattern,
    directoryOnly,
    hasSlash: pattern.includes('/'),
    rootOnly
  }
}

function normalizeRelativePath(value: string): string {
  return value.replace(/\\/g, '/').replace(/\/+/g, '/').replace(/^\/+/, '')
}

function wildcardSegmentPathMatches(pattern: string, relativePath: string): boolean {
  const patternSegments = pattern.split('/')
  const pathSegments = relativePath.split('/')
  if (patternSegments.length !== pathSegments.length) {
    return false
  }
  return patternSegments.every((segment, index) =>
    wildcardSegmentMatches(segment, pathSegments[index] ?? '')
  )
}

function wildcardSegmentMatches(pattern: string, value: string): boolean {
  if (pattern === value) {
    return true
  }
  const escaped = Array.from(pattern, (char) =>
    '*?'.includes(char) ? char : escapeRegExpCharacter(char)
  ).join('')
  const regex = new RegExp(`^${escaped.replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]')}$`)
  return regex.test(value)
}

function escapeRegExpCharacter(char: string): string {
  return '\\^$.*+?()[]{}|'.includes(char) ? `\\${char}` : char
}
