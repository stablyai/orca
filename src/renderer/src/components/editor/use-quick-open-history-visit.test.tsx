// @vitest-environment happy-dom
import { renderHook } from '@testing-library/react'
import { expect, it, vi } from 'vitest'
import type { OpenFile } from '@/store/slices/editor'
import type { FileContent } from './editor-panel-content-types'
import { useQuickOpenHistoryVisit } from './use-quick-open-history-visit'

const record = vi.hoisted(() => vi.fn())
vi.mock('@/store', () => ({ useAppStore: { getState: () => ({}) } }))
vi.mock('@/lib/quick-open-file-history', () => ({ recordQuickOpenFileVisit: record }))
const file: OpenFile = {
  id: 'file',
  worktreeId: 'wt',
  filePath: '/repo/file',
  relativePath: 'file',
  language: 'text',
  isDirty: false,
  mode: 'edit'
}
it('records only successful visible reads and later activations', () => {
  const initial: { content: FileContent | undefined; visible: boolean } = {
    content: undefined,
    visible: true
  }
  const { rerender, unmount } = renderHook(
    ({ content, visible }) => useQuickOpenHistoryVisit(file, content, visible),
    { initialProps: initial }
  )
  rerender({ content: { content: '', isBinary: false, loadError: 'ENOENT' }, visible: true })
  rerender({ content: { content: 'text', isBinary: false, isStale: true }, visible: true })
  rerender({ content: { content: 'text', isBinary: false }, visible: false })
  expect(record).not.toHaveBeenCalled()
  rerender({ content: { content: 'text', isBinary: false }, visible: true })
  expect(record).toHaveBeenCalledWith({}, file)
  unmount()
})
