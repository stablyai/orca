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
