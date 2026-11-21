// @vitest-environment happy-dom

import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type * as DirectoryListingModule from './file-explorer-directory-listing'
import type { FileExplorerDirectoryListing } from './file-explorer-directory-listing'
import type { UseFileExplorerTreeResult } from './file-explorer-types'

const reads = vi.hoisted(() => {
  const state: { dirs: string[]; answers: ((listing: FileExplorerDirectoryListing) => void)[] } = {
    dirs: [],
    answers: []
  }
  return state
})
vi.mock('./file-explorer-directory-listing', async (importOriginal) => ({
  ...(await importOriginal<typeof DirectoryListingModule>()),
  readFileExplorerDirectory: (_worktreeId: unknown, _worktreePath: unknown, dirPath: string) => {
    reads.dirs.push(dirPath)
    return new Promise<FileExplorerDirectoryListing>((resolve) => reads.answers.push(resolve))
  }
}))

import { useFileExplorerTree } from './useFileExplorerTree'

const EXPANDED = new Set<string>()
let tree: UseFileExplorerTreeResult | null = null
let root: Root | null = null

function TreeProbe(): null {
  tree = useFileExplorerTree('/repo', EXPANDED, 'repo-1')
  return null
}

async function mountFilesPanel(): Promise<void> {
  root = createRoot(document.createElement('div'))
  await act(async () => root!.render(createElement(TreeProbe)))
  await act(async () => tree!.resetAndLoad())
}

afterEach(() => {
  act(() => root?.unmount())
  root = null
})

describe('useFileExplorerTree across panel visits', () => {
  it('reopens on the listing it showed and rechecks it in the background', async () => {
    await mountFilesPanel()
    await act(async () =>
      reads.answers[0]({
        entries: [{ name: 'src', isDirectory: true, isSymlink: false }],
        operationOwner: { kind: 'local' }
      })
    )
    act(() => root!.unmount())
    root = null

    await mountFilesPanel()

    expect(tree!.dirCache['/repo']?.children.map((node) => node.name)).toEqual(['src'])
    expect(reads.dirs).toEqual(['/repo', '/repo'])
  })
})
