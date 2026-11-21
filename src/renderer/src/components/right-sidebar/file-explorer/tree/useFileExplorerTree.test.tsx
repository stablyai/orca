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

let tree: UseFileExplorerTreeResult | null = null
let root: Root | null = null

function TreeProbe(props: { worktreeId: string; expanded: Set<string> }): null {
  tree = useFileExplorerTree('/repo', props.expanded, props.worktreeId)
  return null
}

async function mountFilesPanel(worktreeId = 'repo-1', expanded = new Set<string>()): Promise<void> {
  root = createRoot(document.createElement('div'))
  await act(async () => root!.render(createElement(TreeProbe, { worktreeId, expanded })))
  await act(async () => tree!.resetAndLoad())
}

function answerLatest(entries: { name: string; isDirectory: boolean }[]): Promise<void> {
  return act(async () =>
    reads.answers.at(-1)!({
      entries: entries.map((entry) => ({ ...entry, isSymlink: false })),
      operationOwner: { kind: 'local' }
    })
  )
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

  it('rechecks expanded folders later when a watcher read supersedes the reopen', async () => {
    const expanded = new Set(['/repo/src'])
    await mountFilesPanel('repo-2', expanded)
    await answerLatest([{ name: 'src', isDirectory: true }])
    act(() => {
      void tree!.loadDir('/repo/src', 0)
    })
    await answerLatest([{ name: 'old.ts', isDirectory: false }])
    act(() => root!.unmount())
    root = null

    await mountFilesPanel('repo-2', expanded)
    const reopenRead = reads.answers.at(-1)!
    act(() => {
      void tree!.refreshDir('/repo')
    })
    await answerLatest([{ name: 'src', isDirectory: true }])
    await act(async () =>
      reopenRead({
        entries: [{ name: 'src', isDirectory: true, isSymlink: false }],
        operationOwner: { kind: 'local' }
      })
    )

    expect(tree!.isDirStale('/repo/src')).toBe(true)
  })
})
