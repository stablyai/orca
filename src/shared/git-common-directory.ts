import { readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import { waitForPromiseWithSignal } from './abort-signal-reason'
import { resolveGitMetadataPath, type GitMetadataPathOptions } from './git-metadata-path'
import { parseGitdirMarkerPayload } from './gitdir-marker-payload'

export type GitAdminReadOptions = GitMetadataPathOptions & { signal?: AbortSignal }

type GitLayoutStat = { isDirectory(): boolean; isFile(): boolean }
export type GitCommonDirectoryReader = {
  statPath(path: string): Promise<GitLayoutStat>
  readPath(path: string): Promise<string | null>
  join(...paths: string[]): string
  resolvePath(base: string, pointer: string): string | null
  parseMarker(content: string): string | null
  isMissing(error: unknown): boolean
}

export function isMissingGitAdminEntry(error: unknown): boolean {
  return (
    error instanceof Error &&
    'code' in error &&
    (error.code === 'ENOENT' || error.code === 'ENOTDIR')
  )
}

export async function readGitAdminFile(
  filePath: string,
  signal?: AbortSignal
): Promise<string | null> {
  signal?.throwIfAborted()
  try {
    return await readFile(filePath, { encoding: 'utf8', signal })
  } catch (error) {
    if (isMissingGitAdminEntry(error)) {
      return null
    }
    throw error
  }
}

/** Read the owning host's Git layout without starting a subprocess. */
export async function resolveGitCommonDirectory(
  repoPath: string,
  options: GitAdminReadOptions = {},
  reader: GitCommonDirectoryReader = {
    statPath: (file) => waitForPromiseWithSignal(stat(file), options.signal),
    readPath: (file) => readGitAdminFile(file, options.signal),
    join: path.join,
    resolvePath: (base, pointer) => resolveGitMetadataPath(base, pointer, options),
    parseMarker: parseGitdirMarkerPayload,
    isMissing: isMissingGitAdminEntry
  }
): Promise<string | null> {
  const dotGit = reader.join(repoPath, '.git')
  let metadata: GitLayoutStat | undefined
  let gitDir: string | null = null
  try {
    metadata = await reader.statPath(dotGit)
  } catch (error) {
    if (!reader.isMissing(error)) {
      throw error
    }
    if ((await reader.readPath(reader.join(repoPath, 'HEAD'))) !== null) {
      gitDir = repoPath
    }
  }
  if (metadata?.isDirectory()) {
    gitDir = dotGit
  } else if (metadata?.isFile()) {
    const marker = reader.parseMarker((await reader.readPath(dotGit)) ?? '')
    if (marker) {
      gitDir = reader.resolvePath(repoPath, marker)
    }
  }
  if (!gitDir) {
    return null
  }
  const commonDir = (await reader.readPath(reader.join(gitDir, 'commondir')))?.trim()
  return commonDir ? reader.resolvePath(gitDir, commonDir) : gitDir
}
