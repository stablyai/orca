import type { Dirent } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { MarkdownDocumentListingCapacityError } from './markdown-document-listing-limits'
import { discoverMarkdownRelativePaths } from './node-markdown-document-discovery'

function entry(name: string, kind: 'directory' | 'file' | 'symlink' = 'file'): Dirent {
  return {
    name,
    isDirectory: () => kind === 'directory',
    isFile: () => kind === 'file',
    isSymbolicLink: () => kind === 'symlink'
  } as Dirent
}

function reader(entriesByPath: Record<string, Dirent[]>) {
  return async (path: string): Promise<AsyncIterable<Dirent>> => ({
    async *[Symbol.asyncIterator]() {
      yield* entriesByPath[path] ?? []
    }
  })
}

describe('bounded Markdown document discovery', () => {
  it('preserves depth-first discovery and skips excluded and symlinked directories', async () => {
    const result = await discoverMarkdownRelativePaths('/repo', {
      readDirectory: reader({
        '/repo': [
          entry('README.md'),
          entry('.git', 'directory'),
          entry('docs', 'directory'),
          entry('linked', 'symlink')
        ],
        '/repo/docs': [entry('guide.mdx'), entry('app.ts')]
      }),
      shouldDescend: (_relativePath, name) => name !== '.git'
    })

    expect(result).toEqual(['README.md', 'docs/guide.mdx'])
  })

  it('stops consuming a wide directory at the visited-entry limit', async () => {
    let yielded = 0
    const readDirectory = async (): Promise<AsyncIterable<Dirent>> => ({
      async *[Symbol.asyncIterator]() {
        for (let index = 0; index < 10_000; index += 1) {
          yielded += 1
          yield entry(`source-${index}.ts`)
        }
      }
    })

    await expect(
      discoverMarkdownRelativePaths('/repo', {
        limits: { maxVisitedEntries: 2 },
        readDirectory,
        shouldDescend: () => true
      })
    ).rejects.toBeInstanceOf(MarkdownDocumentListingCapacityError)
    expect(yielded).toBe(3)
  })

  it('rejects a directory deeper than the configured traversal limit', async () => {
    await expect(
      discoverMarkdownRelativePaths('/repo', {
        limits: { maxDepth: 1 },
        readDirectory: reader({
          '/repo': [entry('one', 'directory')],
          '/repo/one': [entry('two', 'directory')]
        }),
        shouldDescend: () => true
      })
    ).rejects.toBeInstanceOf(MarkdownDocumentListingCapacityError)
  })
})

// Why these run on every platform, not just Windows: the separator contract is a
// property of the ROOT SHAPE the caller owns, not of the host. A POSIX root
// reaches this function on Windows through the WSL/SSH/relay boundary
// (SshFilesystemProvider.listFiles speaks POSIX regardless of client OS), and a
// native root reaches it from a local worktree. Both must round-trip whatever the
// caller named — using path.join here rewrote POSIX roots to `\repo\docs` on
// Windows, which the reader could not resolve.
describe('path separator ownership', () => {
  const posixTree = {
    '/repo': [entry('README.md'), entry('docs', 'directory')],
    '/repo/docs': [entry('guide.mdx')]
  }
  const windowsTree = {
    'C:\\repo': [entry('README.md'), entry('docs', 'directory')],
    'C:\\repo\\docs': [entry('guide.mdx')]
  }

  it('descends a POSIX root, hands the reader POSIX paths, and returns POSIX keys', async () => {
    const seen: string[] = []
    const result = await discoverMarkdownRelativePaths('/repo', {
      readDirectory: async (path) => {
        seen.push(path)
        return {
          async *[Symbol.asyncIterator]() {
            yield* posixTree[path as keyof typeof posixTree] ?? []
          }
        }
      },
      shouldDescend: () => true
    })

    expect(seen).toEqual(['/repo', '/repo/docs'])
    expect(result).toEqual(['README.md', 'docs/guide.mdx'])
  })

  it('descends a WINDOWS root and hands the reader native paths', async () => {
    const seen: string[] = []
    const result = await discoverMarkdownRelativePaths('C:\\repo', {
      readDirectory: async (path) => {
        seen.push(path)
        return {
          async *[Symbol.asyncIterator]() {
            yield* windowsTree[path as keyof typeof windowsTree] ?? []
          }
        }
      },
      shouldDescend: () => true
    })

    expect(seen).toEqual(['C:\\repo', 'C:\\repo\\docs'])
    // Relative keys stay POSIX for BOTH roots — they are the renderer-facing
    // identity and must not vary by host, matching retainMarkdownRelativePath.
    expect(result).toEqual(['README.md', 'docs/guide.mdx'])
  })

  it('applies the depth limit identically for a Windows root', async () => {
    await expect(
      discoverMarkdownRelativePaths('C:\\repo', {
        limits: { maxDepth: 1 },
        readDirectory: reader({
          'C:\\repo': [entry('one', 'directory')],
          'C:\\repo\\one': [entry('two', 'directory')]
        }),
        shouldDescend: () => true
      })
    ).rejects.toBeInstanceOf(MarkdownDocumentListingCapacityError)
  })

  it('does not double a separator when the root carries a trailing one', async () => {
    const seen: string[] = []
    await discoverMarkdownRelativePaths('/repo/', {
      readDirectory: async (path) => {
        seen.push(path)
        return {
          async *[Symbol.asyncIterator]() {
            yield* path === '/repo/' ? [entry('docs', 'directory')] : []
          }
        }
      },
      shouldDescend: () => true
    })

    expect(seen).toEqual(['/repo/', '/repo/docs'])
  })
})
