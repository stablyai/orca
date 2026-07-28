import { opendir } from 'node:fs/promises'
import type { Dirent, Dir } from 'node:fs'
import { join } from 'node:path'
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
          await visitDirectory(join(absoluteDirectoryPath, entry.name), relativePath, nextDepth)
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
