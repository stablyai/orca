// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { OpenFile } from '@/store/slices/editor'
import { EditorPanelHeaderPath } from './EditorPanelHeaderPath'

const renameFileOnDiskMock = vi.hoisted(() => vi.fn())

vi.mock('@/store/selectors', () => ({
  useWorktreeById: () => ({ path: '/repo', repoId: 'repo-1' })
}))

vi.mock('@/lib/rename-file', () => ({
  renameFileOnDisk: renameFileOnDiskMock
}))

vi.mock('@/hooks/useShortcutLabel', () => ({
  useShortcutLabel: () => ''
}))

vi.mock('@/i18n/i18n', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/i18n/i18n')>() // eslint-disable-line @typescript-eslint/consistent-type-imports -- vi.mock requires an inline import
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
      onOpenContainingFolder={vi.fn()}
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
        onOpenContainingFolder={vi.fn()}
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

  it('opens a field holding the whole name', () => {
    renderPath(baseFile())
    openRenameInput()

    const input = getRenameInput('Rename file notes.md')
    expect(input.value).toBe('notes.md')
  })

  it('lets the field claim the full header width', () => {
    renderPath(baseFile())
    openRenameInput()

    const input = getRenameInput('Rename file notes.md')
    expect(input.className).toContain('w-full')
    expect(input.className).toContain('max-w-full')
  })

  it('selects the basename so typing replaces just the name', () => {
    renderPath(baseFile())
    openRenameInput()

    const input = getRenameInput('Rename file notes.md')
    expect(document.activeElement).toBe(input)
    expect(input.selectionStart).toBe(0)
    expect(input.selectionEnd).toBe('notes'.length)
  })

  it('renames to the typed name verbatim', () => {
    renderPath(baseFile())
    openRenameInput()

    const input = getRenameInput('Rename file notes.md')
    fireEvent.change(input, { target: { value: 'renamed.mdx' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    expect(renameFileOnDiskMock).toHaveBeenCalledWith({
      oldPath: '/repo/notes.md',
      newName: 'renamed.mdx',
      worktreeId: 'wt-1',
      worktreePath: '/repo'
    })
  })

  it('commits on blur like the tab bar and file explorer', () => {
    renderPath(baseFile())
    openRenameInput()

    const input = getRenameInput('Rename file notes.md')
    fireEvent.change(input, { target: { value: 'renamed.md' } })
    fireEvent.blur(input)

    expect(renameFileOnDiskMock).toHaveBeenCalledWith(
      expect.objectContaining({ newName: 'renamed.md' })
    )
  })

  it('does not request a rename when the name was not edited', () => {
    renderPath(baseFile())
    openRenameInput()

    fireEvent.keyDown(getRenameInput('Rename file notes.md'), { key: 'Enter' })

    expect(renameFileOnDiskMock).not.toHaveBeenCalled()
  })

  it('ignores an Enter that only confirms an IME candidate', () => {
    renderPath(baseFile())
    openRenameInput()

    const input = getRenameInput('Rename file notes.md')
    fireEvent.change(input, { target: { value: 'renamed.md' } })
    fireEvent.keyDown(input, { key: 'Enter', keyCode: 229 })
    expect(renameFileOnDiskMock).not.toHaveBeenCalled()

    fireEvent.keyDown(input, { key: 'Enter', keyCode: 13 })
    expect(renameFileOnDiskMock).toHaveBeenCalledWith(
      expect.objectContaining({ newName: 'renamed.md' })
    )
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

  it('selects the whole name when there is no extension', () => {
    const file = baseFile({
      id: '/repo/Makefile',
      filePath: '/repo/Makefile',
      relativePath: 'Makefile'
    })
    renderPath(file)
    openRenameInput()

    const input = getRenameInput('Rename file Makefile')
    expect(input.selectionStart).toBe(0)
    expect(input.selectionEnd).toBe('Makefile'.length)
  })
})
