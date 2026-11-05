// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type * as I18nModule from '@/i18n/i18n'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { OpenFile } from '@/store/slices/editor'
import { EditorPanelHeaderPath } from './EditorPanelHeaderPath'

const renameFileOnDiskMock = vi.hoisted(() => vi.fn())

vi.mock('@/store/selectors', () => ({
  useWorktreeById: () => ({ path: '/repo', repoId: 'repo-1' })
}))

// Stub owner resolution because this suite does not seed the execution-host catalog.
vi.mock('@/lib/resolved-worktree-execution-host', () => ({
  getResolvedExecutionHostIdForWorktree: () => 'local'
}))

vi.mock('@/lib/rename-file', () => ({
  renameFileOnDisk: renameFileOnDiskMock
}))

vi.mock('@/hooks/useShortcutLabel', () => ({
  useShortcutLabel: () => ''
}))

vi.mock('@/i18n/i18n', async (importOriginal) => {
  const actual = await importOriginal<typeof I18nModule>()
  return {
    ...actual,
    translate: (_key: string, fallback: string, options?: { value0?: string }) =>
      fallback.replace('{{value0}}', options?.value0 ?? '')
  }
})

afterEach(cleanup)

function baseFile(overrides: Partial<OpenFile> = {}): OpenFile {
  return {
    id: '/repo/notes.md',
    filePath: '/repo/notes.md',
    relativePath: 'notes.md',
    worktreeId: 'wt-1',
    language: 'markdown',
    isDirty: false,
    mode: 'edit',
    ...overrides
  }
}

function renderPath(file: OpenFile): (next: OpenFile) => void {
  const view = render(
    <EditorPanelHeaderPath
      activeFile={file}
      copiedPathVisible={false}
      canShowMarkdownPreview={false}
      onCopyPath={vi.fn()}
      onOpenMarkdownPreview={vi.fn()}
    />
  )
  return (next) =>
    view.rerender(
      <EditorPanelHeaderPath
        activeFile={next}
        copiedPathVisible={false}
        canShowMarkdownPreview={false}
        onCopyPath={vi.fn()}
        onOpenMarkdownPreview={vi.fn()}
      />
    )
}

function getRenameInput(label: string): HTMLInputElement {
  const input = screen.getByLabelText(label)
  if (!(input instanceof HTMLInputElement)) {
    throw new Error(`Missing rename input: ${label}`)
  }
  return input
}

function openRenameInput(): void {
  const pathRow = document.querySelector('.editor-header-path-row')
  if (!pathRow) {
    throw new Error('Missing editor header path row')
  }
  fireEvent.contextMenu(pathRow)
  fireEvent.click(screen.getByRole('menuitem', { name: 'Rename' }))
}

describe('EditorPanelHeaderPath inline rename', () => {
  beforeEach(() => {
    renameFileOnDiskMock.mockReset()
    Object.assign(window, { api: { ui: { writeClipboardText: vi.fn() } } })
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      callback(0)
      return 1
    })
    vi.stubGlobal('cancelAnimationFrame', vi.fn())
  })

  it('ignores IME confirmation and its redispatch before accepting deliberate Enter', () => {
    renderPath(baseFile())
    openRenameInput()

    const input = getRenameInput('Rename file notes.md')
    const frames: FrameRequestCallback[] = []
    const raf = vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
      frames.push(callback)
      return frames.length
    })
    try {
      fireEvent.compositionStart(input)
      fireEvent.change(input, { target: { value: 'renamed.md' } })
      fireEvent.keyDown(input, { key: 'Enter', keyCode: 229 })
      fireEvent.compositionEnd(input)
      fireEvent.keyUp(input, { key: 'Enter', keyCode: 13 })
      expect(renameFileOnDiskMock).not.toHaveBeenCalled()

      fireEvent.keyDown(input, { key: 'Enter', keyCode: 13 })
      expect(renameFileOnDiskMock).not.toHaveBeenCalled()
      expect(getRenameInput('Rename file notes.md')).toBe(input)

      fireEvent.keyUp(input, { key: 'Enter', keyCode: 13 })
      for (const frame of frames) {
        frame(0)
      }
      fireEvent.keyDown(input, { key: 'Enter', keyCode: 13 })
      expect(renameFileOnDiskMock).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ newName: 'renamed.md' })
      )
    } finally {
      raf.mockRestore()
    }
  })

  it('cancels on Escape without a trailing blur-commit, and ignores empty renames', () => {
    renderPath(baseFile())
    openRenameInput()

    const input = getRenameInput('Rename file notes.md')
    fireEvent.change(input, { target: { value: 'renamed.md' } })
    fireEvent.keyDown(input, { key: 'Escape' })
    fireEvent.blur(input)
    expect(renameFileOnDiskMock).not.toHaveBeenCalled()
    expect(screen.queryByLabelText('Rename file notes.md')).toBeNull()

    openRenameInput()
    fireEvent.change(getRenameInput('Rename file notes.md'), { target: { value: '   ' } })
    fireEvent.keyDown(getRenameInput('Rename file notes.md'), { key: 'Enter' })
    expect(renameFileOnDiskMock).not.toHaveBeenCalled()
  })

  it('drops rename mode when the active file changes', () => {
    const rerenderPath = renderPath(baseFile())
    openRenameInput()

    const input = getRenameInput('Rename file notes.md')
    fireEvent.change(input, { target: { value: 'renamed.md' } })
    rerenderPath(
      baseFile({
        id: '/repo/other.md',
        filePath: '/repo/other.md',
        relativePath: 'other.md'
      })
    )

    expect(screen.queryByLabelText('Rename file notes.md')).toBeNull()
    expect(screen.queryByLabelText('Rename file other.md')).toBeNull()

    expect(renameFileOnDiskMock).not.toHaveBeenCalled()
  })
})
