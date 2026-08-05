import { opendir } from 'node:fs/promises'
import type { Dirent, Dir } from 'node:fs'
import {
  assertMarkdownDocumentPathWithinLimit,
  createMarkdownDocumentListingBudget,
  MarkdownDocumentListingCapacityError,
  retainMarkdownRelativePath,
  visitMarkdownDocumentListingEntry,
  type MarkdownDocumentListingLimits
} from './markdown-document-listing-limits'

type MarkdownDirectoryReader = (path: string) => Promise<Dir | AsyncIterable<Dirent>>

export type MarkdownDocumentDiscoveryOptions = {
  shouldDescend: (relativePath: string, name: string) => boolean
  ignoreNestedDirectoryErrors?: boolean
  limits?: Partial<MarkdownDocumentListingLimits>
  readDirectory?: MarkdownDirectoryReader
  signal?: AbortSignal
}

export function isMarkdownDocumentPath(path: string): boolean {
  const lowerPath = path.toLowerCase()
  return lowerPath.endsWith('.md') || lowerPath.endsWith('.mdx') || lowerPath.endsWith('.markdown')
}

/**
 * Appends a directory entry to the path handed back to the reader.
 *
 * THIS FUNCTION OWNS THE SEPARATOR CONTRACT, which is why it is not `path.join`.
 * A root may legitimately arrive in either shape on Windows: a local worktree
 * gives native `C:\repo`, while a WSL/SSH/relay root gives POSIX `/repo`
 * (SshFilesystemProvider.listFiles and the relay's `fs.listFiles` both speak
 * POSIX regardless of client platform). `path.join` on Windows rewrites every
 * separator to `\`, so a POSIX root would be handed back to the reader as
 * `\repo\docs` — a path the caller never named and, for a remote reader, one
 * that cannot resolve at all.
 *
 * Appending with the separator the root ALREADY uses keeps both shapes intact
 * and round-trips whatever the caller owns. Relative keys stay POSIX
 * unconditionally (see the `/` join in visitDirectory), matching
 * retainMarkdownRelativePath, which normalizes `\` to `/` for the same reason.
 */
function appendPathSegment(parentPath: string, name: string): string {
  if (parentPath === '') {
    return name
  }
  const usesBackslash = parentPath.includes('\\') && !parentPath.includes('/')
  const separator = usesBackslash ? '\\' : '/'
  const trimmedParent = parentPath.replace(/[\\/]+$/, '')
  return `${trimmedParent}${separator}${name}`
}

export async function discoverMarkdownRelativePaths(
  rootPath: string,
  options: MarkdownDocumentDiscoveryOptions
): Promise<string[]> {
  const budget = createMarkdownDocumentListingBudget(options.limits)
  const documents: string[] = []
  const readDirectory = options.readDirectory ?? opendir
  assertMarkdownDocumentPathWithinLimit(rootPath, budget.limits.maxPathBytes)

  const visitDirectory = async (
    absoluteDirectoryPath: string,
    relativeDirectoryPath: string,
    depth: number
  ): Promise<void> => {
    throwIfAborted(options.signal)
    let directory: Dir | AsyncIterable<Dirent>
    try {
      directory = await readDirectory(absoluteDirectoryPath)
    } catch (error) {
      if (depth > 0 && options.ignoreNestedDirectoryErrors) {
        return
      }
      throw error
    }

    for await (const entry of directory) {
      throwIfAborted(options.signal)
      const relativePath = relativeDirectoryPath
        ? `${relativeDirectoryPath}/${entry.name}`
        : entry.name
      const nextDepth = depth + 1
      const shouldDescend = entry.isDirectory() && options.shouldDescend(relativePath, entry.name)
      visitMarkdownDocumentListingEntry(budget, relativePath, shouldDescend ? nextDepth : depth)
      if (entry.isSymbolicLink()) {
        continue
      }
      if (entry.isDirectory()) {
        if (shouldDescend) {
          await visitDirectory(
            appendPathSegment(absoluteDirectoryPath, entry.name),
            relativePath,
            nextDepth
          )
        }
        continue
      }
      if (entry.isFile() && isMarkdownDocumentPath(entry.name)) {
        retainMarkdownRelativePath(budget, rootPath, relativePath)
        documents.push(relativePath)
      }
    }
  }

  await visitDirectory(rootPath, '', 0)
  return documents
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) {
    return
  }
  throw signal.reason instanceof Error ? signal.reason : new MarkdownDocumentListingCapacityError()
}
