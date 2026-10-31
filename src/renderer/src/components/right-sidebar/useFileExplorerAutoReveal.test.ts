// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, renderHook } from '@testing-library/react'
import type { Virtualizer } from '@tanstack/react-virtual'
import type { OpenFile } from '@/store/slices/editor'
import type { FileExplorerRowProjection } from './file-explorer-row-projection'
import { useFileExplorerAutoReveal } from './useFileExplorerAutoReveal'

const WORKTREE = '/repo'
const FILE = '/repo/docs/second.md'

function openFile(id: string, filePath: string): OpenFile {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the hook reads only id, worktreeId, mode and filePath.
  return { id, worktreeId: 'wt-1', mode: 'edit', filePath } as OpenFile
}

function harness(followActiveFile: boolean) {
  const setSelectedPath = vi.fn()
  const scrollToIndex = vi.fn()
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the hook calls only scrollToIndex.
  const virtualizer = { scrollToIndex } as unknown as Virtualizer<HTMLDivElement, Element>
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the hook calls only hasPath and getIndexByPath.
  const rowProjection = {
    hasPath: (path: string) => path === FILE,
    getIndexByPath: (path: string) => (path === FILE ? 3 : null)
  } as unknown as FileExplorerRowProjection
  const files = [openFile('first', '/repo/first.md'), openFile('second', FILE)]
  const render = (activeFileId: string) =>
    renderHook(
      ({ active }: { active: string }) =>
        useFileExplorerAutoReveal({
          followActiveFile,
          activeFileId: active,
          activeWorktreeId: 'wt-1',
          worktreePath: WORKTREE,
          pendingExplorerReveal: null,
          openFiles: files,
          rowProjection,
          setSelectedPath,
          virtualizer
        }),
      { initialProps: { active: activeFileId } }
    )
  return { render, setSelectedPath, scrollToIndex }
}

describe('useFileExplorerAutoReveal', () => {
  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })

  it('selects and scrolls to the newly active file when following is on', async () => {
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => {
      cb(0)
      return 1
    })
    const { render, setSelectedPath, scrollToIndex } = harness(true)
    const hook = render('first')
    hook.rerender({ active: 'second' })
    expect(setSelectedPath).toHaveBeenCalledWith(FILE)
    expect(scrollToIndex).toHaveBeenCalledWith(3, { align: 'auto' })
  })

  it('leaves explorer selection and scroll alone when following is off (#35887)', () => {
    const { render, setSelectedPath, scrollToIndex } = harness(false)
    const hook = render('first')
    hook.rerender({ active: 'second' })
    expect(setSelectedPath).not.toHaveBeenCalled()
    expect(scrollToIndex).not.toHaveBeenCalled()
  })
})
