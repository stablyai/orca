import { readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import { waitForPromiseWithSignal } from './abort-signal-reason'
import { resolveGitMetadataPath, type GitMetadataPathOptions } from './git-metadata-path'
import { parseGitdirMarkerPayload } from './gitdir-marker-payload'

export type GitAdminReadOptions = GitMetadataPathOptions & { signal?: AbortSignal }

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
  options: GitAdminReadOptions = {}
): Promise<string | null> {
  const dotGit = path.join(repoPath, '.git')
  let gitDir: string | null = null
  try {
    const metadata = await waitForPromiseWithSignal(stat(dotGit), options.signal)
    if (metadata.isDirectory()) {
      gitDir = dotGit
    } else if (metadata.isFile()) {
      const marker = parseGitdirMarkerPayload(
        (await readGitAdminFile(dotGit, options.signal)) ?? ''
      )
      if (marker) {
        gitDir = resolveGitMetadataPath(repoPath, marker, options)
      }
    }
  } catch (error) {
    if (!isMissingGitAdminEntry(error)) {
      throw error
    }
    if ((await readGitAdminFile(path.join(repoPath, 'HEAD'), options.signal)) !== null) {
      gitDir = repoPath
    }
  }
  if (!gitDir) {
    return null
  }
  const commonDir = (await readGitAdminFile(path.join(gitDir, 'commondir'), options.signal))?.trim()
  return commonDir ? resolveGitMetadataPath(gitDir, commonDir, options) : gitDir
}
