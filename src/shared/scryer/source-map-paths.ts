import type { SourceLocation } from './model-types'

export type SourceLocationTarget =
  | {
      absolutePath: string
      relativePath: string
      line?: number
      endLine?: number
      command?: string
    }
  | { error: string }

function normalizeSlashes(value: string): string {
  return value.replace(/\\/g, '/').replace(/\/+/g, '/')
}

function trimLeadingCurrentDir(value: string): string {
  return value.replace(/^\.\/+/, '')
}

function hasGlob(value: string): boolean {
  return /[*?[\]{}]/.test(value)
}

function escapeRegex(value: string): string {
  return value.replace(/[.+^${}()|[\]\\]/g, '\\$&')
}

function globToRegex(pattern: string): RegExp {
  const normalized = normalizeSlashes(trimLeadingCurrentDir(pattern))
  let output = '^'
  for (let i = 0; i < normalized.length; i++) {
    const char = normalized[i]
    const next = normalized[i + 1]
    const afterNext = normalized[i + 2]
    if (char === '*' && next === '*' && afterNext === '/') {
      output += '(?:.*/)?'
      i += 2
    } else if (char === '*' && next === '*') {
      output += '.*'
      i++
    } else if (char === '*') {
      output += '[^/]*'
    } else if (char === '?') {
      output += '[^/]'
    } else {
      output += escapeRegex(char)
    }
  }
  output += '$'
  return new RegExp(output)
}

function isInsideWorktree(relativePath: string): boolean {
  const normalized = normalizeSlashes(relativePath)
  return (
    normalized.length > 0 &&
    !normalized.startsWith('/') &&
    !normalized.startsWith('../') &&
    !normalized.includes('/../')
  )
}

function joinWorktreePath(projectPath: string, relativePath: string): string {
  const separator = projectPath.includes('\\') ? '\\' : '/'
  return `${projectPath.replace(/[\\/]+$/, '')}${separator}${relativePath.replace(/\//g, separator)}`
}

export function resolveSourceLocationTarget(args: {
  projectPath: string
  files: string[]
  location: SourceLocation
}): SourceLocationTarget {
  const pattern = normalizeSlashes(trimLeadingCurrentDir(args.location.pattern.trim()))
  if (!isInsideWorktree(pattern)) {
    return { error: `Source pattern '${args.location.pattern}' is outside the worktree.` }
  }

  const candidates = args.files
    .map((file) => normalizeSlashes(trimLeadingCurrentDir(file)))
    .filter(isInsideWorktree)
    .sort((a, b) => a.localeCompare(b))

  const relativePath = hasGlob(pattern)
    ? ((): string | null => {
        const matcher = globToRegex(pattern)
        return candidates.find((file) => matcher.test(file)) ?? null
      })()
    : candidates.includes(pattern)
      ? pattern
      : null

  if (!relativePath) {
    return { error: `No file in this worktree matches source pattern '${args.location.pattern}'.` }
  }

  return {
    absolutePath: joinWorktreePath(args.projectPath, relativePath),
    relativePath,
    ...(args.location.line !== undefined ? { line: args.location.line } : {}),
    ...(args.location.endLine !== undefined ? { endLine: args.location.endLine } : {}),
    ...(args.location.command !== undefined ? { command: args.location.command } : {})
  }
}
