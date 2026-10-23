import { normalizeRuntimePathSeparators } from './cross-platform-path'

/**
 * Why: Claude derives the directory name from the raw cwd, so encoding from the
 * comparison key would lowercase Windows paths and never match on disk. Encode
 * the raw path, plus its NFC spelling, since macOS hands us NFD (#10832).
 */
export function encodeClaudeProjectPaths(pathValue: string): string[] {
  const raw = encodeClaudeProjectPath(pathValue)
  const composed = encodeClaudeProjectPath(pathValue.normalize('NFC'))
  return raw === composed ? [raw] : [raw, composed]
}

/** One dash per non-alphanumeric character — runs are NOT collapsed, so `/.claude` encodes to
 *  `--claude` and `C:\` to `c--`. Anything that collapses runs stops matching real buckets. */
export function encodeClaudeProjectPath(pathValue: string): string {
  const separated = normalizeRuntimePathSeparators(pathValue)
  const trimmed =
    separated === '/' || /^[A-Za-z]:\/$/.test(separated) ? separated : separated.replace(/\/+$/, '')
  return trimmed.replace(/[^a-zA-Z0-9]/g, '-')
}

/**
 * The folder, among `candidates` and their parents, that Claude filed `transcriptPath` under.
 * Why: Claude keeps a session in `projects/<encoded launch folder>/` and `--resume` reads only the
 * bucket of the folder it starts in. Null for a path outside `projects/`, when nothing matches, or
 * when the bucket name fits more than one distinct folder (`/a/foo-bar` and `/a/foo/bar` both
 * encode to `-a-foo-bar`), so the caller keeps its existing choice instead of guessing.
 */
export function findClaudeTranscriptProjectFolder(
  transcriptPath: string | undefined,
  candidates: readonly (string | null | undefined)[]
): string | null {
  const segments = transcriptPath ? normalizeRuntimePathSeparators(transcriptPath).split('/') : []
  const bucket = segments.at(-3) === 'projects' ? segments.at(-2) : undefined
  if (!bucket) {
    return null
  }
  const matches = new Map<string, string>()
  for (const candidate of candidates) {
    for (let folder = candidate || null; folder; folder = parentFolder(folder)) {
      if (encodeClaudeProjectPaths(folder).includes(bucket)) {
        const key = normalizeRuntimePathSeparators(folder).replace(/\/+$/, '') || '/'
        if (!matches.has(key)) {
          matches.set(key, folder)
        }
      }
    }
  }
  if (matches.size !== 1) {
    return null
  }
  return matches.values().next().value ?? null
}

/** Keeps the path's own separators and its root: `/a` → `/`, `C:\a` → `C:\`, `/` → null. */
function parentFolder(folder: string): string | null {
  const trimmed = folder.replace(/[\\/]+$/, '')
  // Why: above a UNC share there is no folder to start in.
  if (/^[\\/]{2}[^\\/]+[\\/][^\\/]+$/.test(trimmed)) {
    return null
  }
  const cut = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'))
  if (cut < 0) {
    return null
  }
  const parent = trimmed.slice(0, cut)
  return parent === '' || /^[A-Za-z]:$/.test(parent) ? trimmed.slice(0, cut + 1) : parent
}

/** Why the explicit boundary: a bare `startsWith` lets a sibling prefix match, so the encoding of
 *  `…/orca` would claim `…/orca-secret` and `…/orcadyne` as its own. */
export function isClaudeProjectDirInScope(
  projectDirName: string,
  scopePrefixes: ReadonlySet<string> | readonly string[]
): boolean {
  for (const prefix of scopePrefixes) {
    if (projectDirName === prefix || projectDirName.startsWith(`${prefix}-`)) {
      return true
    }
  }
  return false
}
