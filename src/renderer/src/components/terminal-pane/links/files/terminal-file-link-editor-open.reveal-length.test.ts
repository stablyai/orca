// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest'

const fake = vi.hoisted(() => ({ schedule: vi.fn() }))
vi.mock('@/store/slices/editor/focus/editor-focus-reveal', () => ({
  scheduleEditorLineReveal: fake.schedule
}))
vi.mock('@/store/slices/editor/tabs/editor-open-target-group', () => ({}))
vi.mock('@/components/tab-group/editor-reveal-flash', () => ({ flashRevealedEditorView: vi.fn() }))
vi.mock('@/store/index', () => {
  const state = {
    unifiedTabsByWorktree: {},
    setMarkdownViewMode: vi.fn(),
    openFileForLink: (
      _file: unknown,
      _options: unknown,
      _intent: unknown,
      reveal: (shown: unknown) => void
    ) => {
      const shown = { fileId: 'file-1', viewStateId: 'view-1', groupId: 'group-1' }
      reveal(shown)
      return shown
    }
  }
  return { useAppStore: { getState: () => state } }
})

import { openLinkedFileInEditor } from './terminal-file-link-editor-open'

afterEach(() => fake.schedule.mockReset())

// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the open reads only these fields; the store is a fake.
const file = { filePath: '/repo/a.ts', relativePath: 'a.ts', worktreeId: 'w1' } as never

it('asks the editor to highlight the given length at the revealed line', () => {
  openLinkedFileInEditor(file, null, { line: 12, column: 1, length: 40 }, () => true)
  expect(fake.schedule).toHaveBeenCalledWith(
    expect.any(Function),
    '/repo/a.ts',
    12,
    1,
    'file-1',
    expect.objectContaining({ viewStateId: 'view-1', matchLength: 40 })
  )
})
