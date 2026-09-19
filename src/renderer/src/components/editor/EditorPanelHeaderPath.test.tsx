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

function renderPath(file: OpenFile): void {
  render(
    <EditorPanelHeaderPath
      activeFile={file}
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

describe('EditorPanelHeaderPath breadcrumb morph rename', () => {
  beforeEach(() => {
    renameFileOnDiskMock.mockReset()
    Object.assign(window, { api: { ui: { writeClipboardText: vi.fn() } } })
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      callback(0)
      return 1
    })
    vi.stubGlobal('cancelAnimationFrame', vi.fn())
  })

  it('morphs into a breadcrumb strip with the basename editable', () => {
    renderPath(baseFile())
    openRenameInput()

    const input = getRenameInput('Rename file notes.md')
    expect(input.value).toBe('notes')
    expect(screen.getByText('.md')).toBeDefined()
    expect(screen.getByText('repo /')).toBeDefined()
  })

  it('shows the full crumb chain without ellipsis cuts', () => {
    renderPath(
      baseFile({
        id: '/repo/docs/marketing/notes.md',
        filePath: '/repo/docs/marketing/notes.md',
        relativePath: 'docs/marketing/notes.md'
      })
    )
    openRenameInput()

    expect(screen.getByText('repo / docs / marketing /')).toBeDefined()
  })

  it('lets the strip claim the full header width instead of capping at 520px', () => {
    renderPath(baseFile())
    openRenameInput()

    const input = getRenameInput('Rename file notes.md')
    const strip = input.parentElement
    if (!strip) {
      throw new Error('Missing rename strip')
    }
    expect(strip.className).toContain('max-w-full')
    expect(strip.className).not.toContain('520px')
  })

  it('selects the basename so typing replaces just the name', () => {
    renderPath(baseFile())
    openRenameInput()

    const input = getRenameInput('Rename file notes.md')
    expect(document.activeElement).toBe(input)
    expect(input.selectionStart).toBe(0)
    expect(input.selectionEnd).toBe('notes'.length)
  })

  it('re-attaches the pinned extension to a bare basename', () => {
    renderPath(baseFile())
    openRenameInput()

    const input = getRenameInput('Rename file notes.md')
    fireEvent.change(input, { target: { value: 'renamed' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    expect(renameFileOnDiskMock).toHaveBeenCalledWith({
      oldPath: '/repo/notes.md',
      newName: 'renamed.md',
      worktreeId: 'wt-1',
      worktreePath: '/repo'
    })
  })

  it('respects an explicitly typed extension without duplicating it', () => {
    renderPath(baseFile())
    openRenameInput()

    const input = getRenameInput('Rename file notes.md')
    fireEvent.change(input, { target: { value: 'renamed.mdx' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    expect(renameFileOnDiskMock).toHaveBeenCalledWith(
      expect.objectContaining({ newName: 'renamed.mdx' })
    )
  })

  it('commits via the confirm button', () => {
    renderPath(baseFile())
    openRenameInput()

    fireEvent.change(getRenameInput('Rename file notes.md'), {
      target: { value: 'renamed.md' }
    })
    fireEvent.mouseDown(screen.getByRole('button', { name: 'Confirm rename' }))
    fireEvent.click(screen.getByRole('button', { name: 'Confirm rename' }))

    expect(renameFileOnDiskMock).toHaveBeenCalledTimes(1)
    expect(renameFileOnDiskMock).toHaveBeenCalledWith(
      expect.objectContaining({ newName: 'renamed.md' })
    )
  })

  it('cancels via the cancel button without renaming', () => {
    renderPath(baseFile())
    openRenameInput()

    fireEvent.change(getRenameInput('Rename file notes.md'), {
      target: { value: 'renamed.md' }
    })
    fireEvent.mouseDown(screen.getByRole('button', { name: 'Cancel rename' }))
    fireEvent.click(screen.getByRole('button', { name: 'Cancel rename' }))

    expect(renameFileOnDiskMock).not.toHaveBeenCalled()
    expect(screen.queryByLabelText('Rename file notes.md')).toBeNull()
  })

  it('cancels on Escape and ignores empty renames', () => {
    renderPath(baseFile())
    openRenameInput()

    const input = getRenameInput('Rename file notes.md')
    fireEvent.change(input, { target: { value: 'renamed.md' } })
    fireEvent.keyDown(input, { key: 'Escape' })
    expect(renameFileOnDiskMock).not.toHaveBeenCalled()
    expect(screen.queryByLabelText('Rename file notes.md')).toBeNull()

    openRenameInput()
    fireEvent.change(getRenameInput('Rename file notes.md'), { target: { value: '   ' } })
    fireEvent.keyDown(getRenameInput('Rename file notes.md'), { key: 'Enter' })
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
