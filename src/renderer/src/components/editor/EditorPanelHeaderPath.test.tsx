// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { OpenFile } from '@/store/slices/editor'
import { EditorPanelHeaderPath } from './EditorPanelHeaderPath'

const readRuntimeDirectory = vi.hoisted(() => vi.fn())
const openFile = vi.hoisted(() => vi.fn())
const openMarkdownPreview = vi.hoisted(() => vi.fn())
const getEditorFileOperationContext = vi.hoisted(() => vi.fn())
const activateTab = vi.hoisted(() => vi.fn())
const writeClipboardText = vi.hoisted(() => vi.fn(async () => undefined))

vi.mock('@/runtime/runtime-file-client', () => ({
  readRuntimeDirectory: (...args: unknown[]) => readRuntimeDirectory(...args)
}))
vi.mock('@/lib/editor-file-operation-owner', () => ({
  getEditorFileOperationContext: (...args: unknown[]) => getEditorFileOperationContext(...args)
}))
vi.mock('@/store', () => {
  const getState = () => ({
    openFile,
    openMarkdownPreview,
    openFiles: [],
    unifiedTabsByWorktree: {},
    activeGroupIdByWorktree: { 'wt-1': 'group-1' },
    activateTab
  })
  const useAppStore = (selector: (state: ReturnType<typeof getState>) => unknown) =>
    selector(getState())
  useAppStore.getState = getState
  return { useAppStore }
})
vi.mock('@/store/selectors', () => ({
  useWorktreeById: () => ({ path: '/repo' })
}))
vi.mock('./editor-header-file-rename', () => ({
  useEditorHeaderFileRename: (file: OpenFile) => ({
    canRename: file.mode === 'edit',
    currentFileName: file.relativePath.split(/[\\/]/).pop() ?? file.relativePath,
    isRenaming: false,
    renameInputRef: () => {},
    openRenameInput: vi.fn(),
    commitRename: vi.fn(),
    cancelRename: vi.fn()
  })
}))
vi.mock('@/hooks/useShortcutLabel', () => ({
  useShortcutLabel: () => '⌘⇧V'
}))
vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string, options?: Record<string, unknown>) =>
    fallback.replace(/\{\{(\w+)\}\}/g, (_match, name: string) =>
      options?.[name] === undefined ? `{{${name}}}` : String(options[name])
    ),
  i18n: { language: 'en' }
}))
vi.mock('../tab-bar/SortableTab', () => ({
  CLOSE_ALL_CONTEXT_MENUS_EVENT: 'close-all-context-menus'
}))
vi.mock('@/components/ui/popover', async () => {
  const { cloneElement, createContext, isValidElement, useContext, useMemo } = await import('react')
  const PopoverContext = createContext<{
    open: boolean
    onOpenChange?: (open: boolean) => void
  }>({ open: false })

  return {
    Popover: ({
      children,
      open = false,
      onOpenChange
    }: {
      children: React.ReactNode
      open?: boolean
      onOpenChange?: (open: boolean) => void
    }) => {
      const contextValue = useMemo(() => ({ open, onOpenChange }), [onOpenChange, open])
      return <PopoverContext.Provider value={contextValue}>{children}</PopoverContext.Provider>
    },
    PopoverContent: ({ children }: { children: React.ReactNode }) => (
      <div data-editor-header-path-menu>{children}</div>
    ),
    PopoverTrigger: ({ children }: { children: React.ReactNode }) => {
      const { open, onOpenChange } = useContext(PopoverContext)
      if (!isValidElement<{ onClick?: (event: unknown) => void }>(children)) {
        return children
      }
      return cloneElement(children, {
        onClick: (event: unknown) => {
          children.props.onClick?.(event)
          onOpenChange?.(!open)
        }
      })
    }
  }
})
vi.mock('@/components/ui/dropdown-menu', () => ({
  DropdownMenu: ({ children, open }: { children: React.ReactNode; open: boolean }) =>
    open ? <>{children}</> : null,
  DropdownMenuTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  DropdownMenuContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DropdownMenuItem: ({
    children,
    onSelect
  }: {
    children: React.ReactNode
    onSelect?: () => void
  }) => <button onClick={onSelect}>{children}</button>,
  DropdownMenuSeparator: () => null,
  DropdownMenuShortcut: ({ children }: { children: React.ReactNode }) => <>{children}</>
}))

function makeOpenFile(overrides: Partial<OpenFile> = {}): OpenFile {
  return {
    id: '/repo/src/lib/path.ts',
    filePath: '/repo/src/lib/path.ts',
    relativePath: 'src/lib/path.ts',
    worktreeId: 'wt-1',
    language: 'typescript',
    isDirty: false,
    mode: 'edit',
    ...overrides
  }
}

function renderPath(file: OpenFile): void {
  render(
    <EditorPanelHeaderPath
      activeFile={file}
      canShowMarkdownPreview={false}
      onOpenMarkdownPreview={vi.fn()}
      onOpenContainingFolder={vi.fn()}
    />
  )
}

afterEach(() => {
  cleanup()
})

beforeEach(() => {
  vi.clearAllMocks()
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: { ui: { writeClipboardText } }
  })
  getEditorFileOperationContext.mockReturnValue({
    settings: {},
    worktreeId: 'wt-1',
    worktreePath: '/repo',
    expectedExecutionHostId: 'local'
  })
  readRuntimeDirectory.mockImplementation(async (_context: unknown, dirPath: string) => {
    if (dirPath === '/repo/src') {
      return [
        { name: 'lib', isDirectory: true, isSymlink: false },
        { name: 'main.ts', isDirectory: false, isSymlink: false }
      ]
    }
    if (dirPath === '/repo/src/lib') {
      return [
        { name: 'other.ts', isDirectory: false, isSymlink: false },
        { name: 'path.ts', isDirectory: false, isSymlink: false }
      ]
    }
    if (dirPath === '/repo/docs') {
      return [
        { name: 'README.md', isDirectory: false, isSymlink: false },
        { name: 'guide.md', isDirectory: false, isSymlink: false }
      ]
    }
    throw new Error(`unexpected dir ${dirPath}`)
  })
})

describe('EditorPanelHeaderPath', () => {
  it('keeps the filename inside .editor-header-path for real file tabs', () => {
    renderPath(makeOpenFile())
    const path = document.querySelector('.editor-header-path')
    expect(path?.textContent).toContain('path.ts')
    expect(path?.querySelectorAll('[data-editor-header-path-segment]')).toHaveLength(3)
  })

  it('keeps virtual tabs as a single static label', () => {
    renderPath(
      makeOpenFile({
        id: '/repo/src/lib/path.ts::unstaged',
        mode: 'diff',
        diffSource: 'unstaged'
      })
    )
    const path = document.querySelector('.editor-header-path')
    expect(path?.textContent).toContain('path.ts')
    expect(path?.textContent).toContain('(diff)')
    expect(path?.querySelectorAll('[data-editor-header-path-segment]')).toHaveLength(0)
    expect(path?.className).toContain('editor-header-path--static')
  })

  it('keeps absolute relative paths as a single static label', () => {
    renderPath(
      makeOpenFile({
        filePath: '/outside/path.ts',
        relativePath: '/outside/path.ts'
      })
    )
    const path = document.querySelector('.editor-header-path')
    expect(path?.querySelectorAll('[data-editor-header-path-segment]')).toHaveLength(0)
    expect(path?.className).toContain('editor-header-path--static')
  })

  it('leaves the preview suffix beside the filename instead of making it a segment', () => {
    renderPath(
      makeOpenFile({
        id: 'markdown-preview::/repo/docs/README.md',
        filePath: '/repo/docs/README.md',
        relativePath: 'docs/README.md',
        language: 'markdown',
        mode: 'markdown-preview'
      })
    )
    const path = document.querySelector('.editor-header-path')
    expect(path?.textContent).toContain('README.md')
    expect(path?.textContent).toContain('(preview)')
    expect(
      [...path!.querySelectorAll('[data-editor-header-path-segment]')].map(
        (node) => node.textContent
      )
    ).toEqual(['docs', 'README.md'])
  })

  it('lists the current directory from the filename and the clicked parent from an ancestor', async () => {
    render(
      <EditorPanelHeaderPath
        activeFile={makeOpenFile()}
        canShowMarkdownPreview={false}
        onOpenMarkdownPreview={vi.fn()}
        onOpenContainingFolder={vi.fn()}
      />
    )

    fireEvent.click(screen.getByRole('button', { name: 'Browse path.ts' }))
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'other.ts' })).toBeTruthy()
    })
    expect(readRuntimeDirectory).toHaveBeenCalledWith(expect.anything(), '/repo/src/lib')
    expect(screen.getByRole('button', { name: 'path.ts' }).getAttribute('data-current')).toBe(
      'true'
    )

    fireEvent.click(screen.getByRole('button', { name: 'Browse src' }))
    expect(screen.queryByRole('button', { name: 'other.ts' })).toBeNull()
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'main.ts' })).toBeTruthy()
    })
    expect(readRuntimeDirectory).toHaveBeenCalledWith(expect.anything(), '/repo/src')
    expect(
      screen.getByRole('button', { name: 'lib' }).getAttribute('data-editor-header-path-entry-kind')
    ).toBe('directory')

    fireEvent.click(screen.getByRole('button', { name: 'lib' }))
    expect(screen.queryByRole('button', { name: 'main.ts' })).toBeNull()
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'path.ts' })).toBeTruthy()
    })
    expect(readRuntimeDirectory).toHaveBeenLastCalledWith(expect.anything(), '/repo/src/lib')
  })

  it('opens a sibling file with openFile and keeps preview for markdown targets', async () => {
    renderPath(makeOpenFile())
    fireEvent.click(screen.getByRole('button', { name: 'Browse path.ts' }))
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'other.ts' })).toBeTruthy()
    })
    fireEvent.click(screen.getByRole('button', { name: 'other.ts' }))
    expect(openFile).toHaveBeenCalledWith(
      expect.objectContaining({
        filePath: '/repo/src/lib/other.ts',
        relativePath: 'src/lib/other.ts',
        mode: 'edit'
      }),
      { targetGroupId: 'group-1' }
    )
    expect(openMarkdownPreview).not.toHaveBeenCalled()

    cleanup()
    renderPath(
      makeOpenFile({
        id: 'markdown-preview::/repo/docs/README.md',
        filePath: '/repo/docs/README.md',
        relativePath: 'docs/README.md',
        language: 'markdown',
        mode: 'markdown-preview'
      })
    )
    fireEvent.click(screen.getByRole('button', { name: 'Browse README.md' }))
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'guide.md' })).toBeTruthy()
    })
    fireEvent.click(screen.getByRole('button', { name: 'guide.md' }))
    expect(openMarkdownPreview).toHaveBeenCalledWith(
      expect.objectContaining({
        filePath: '/repo/docs/guide.md',
        relativePath: 'docs/guide.md',
        language: 'markdown'
      }),
      { targetGroupId: 'group-1' }
    )
  })

  it('shows a listing error inside the popover', async () => {
    readRuntimeDirectory.mockRejectedValueOnce(new Error('EACCES: permission denied'))
    renderPath(makeOpenFile())
    fireEvent.click(screen.getByRole('button', { name: 'Browse path.ts' }))
    await waitFor(() => {
      expect(screen.getByRole('alert').textContent).toContain('EACCES')
    })
  })

  it('keeps an open listing mounted when unrelated file state changes', async () => {
    const file = makeOpenFile()
    const { rerender } = render(
      <EditorPanelHeaderPath
        activeFile={file}
        canShowMarkdownPreview={false}
        onOpenMarkdownPreview={vi.fn()}
        onOpenContainingFolder={vi.fn()}
      />
    )
    fireEvent.click(screen.getByRole('button', { name: 'Browse path.ts' }))
    const entry = await screen.findByRole('button', { name: 'other.ts' })

    rerender(
      <EditorPanelHeaderPath
        activeFile={{ ...file, isDirty: true }}
        canShowMarkdownPreview={false}
        onOpenMarkdownPreview={vi.fn()}
        onOpenContainingFolder={vi.fn()}
      />
    )

    expect(screen.getByRole('button', { name: 'other.ts' })).toBe(entry)
    expect(readRuntimeDirectory).toHaveBeenCalledOnce()
  })

  it('keeps path context-menu actions reachable', () => {
    const file = makeOpenFile()
    const onOpenContainingFolder = vi.fn()
    render(
      <EditorPanelHeaderPath
        activeFile={file}
        canShowMarkdownPreview={false}
        onOpenMarkdownPreview={vi.fn()}
        onOpenContainingFolder={onOpenContainingFolder}
      />
    )
    fireEvent.contextMenu(document.querySelector('.editor-header-path-row')!)
    fireEvent.click(screen.getByText('Copy Path'))
    fireEvent.click(screen.getByText('Copy Relative Path'))
    fireEvent.click(screen.getByText(/Reveal in|Open Containing Folder/))
    expect(writeClipboardText).toHaveBeenNthCalledWith(1, file.filePath)
    expect(writeClipboardText).toHaveBeenNthCalledWith(2, file.relativePath)
    expect(onOpenContainingFolder).toHaveBeenCalledOnce()
  })

  it('remounts breadcrumbs when the active file changes', async () => {
    let resolveOldListing!: (entries: unknown[]) => void
    readRuntimeDirectory.mockImplementationOnce(
      () => new Promise((resolve) => (resolveOldListing = resolve))
    )
    const firstFile = makeOpenFile()
    const secondFile = makeOpenFile({
      id: '/repo/docs/README.md',
      filePath: '/repo/docs/README.md',
      relativePath: 'docs/README.md',
      language: 'markdown'
    })
    const { rerender } = render(
      <EditorPanelHeaderPath
        activeFile={firstFile}
        canShowMarkdownPreview={false}
        onOpenMarkdownPreview={vi.fn()}
        onOpenContainingFolder={vi.fn()}
      />
    )
    fireEvent.click(screen.getByRole('button', { name: 'Browse path.ts' }))

    rerender(
      <EditorPanelHeaderPath
        activeFile={secondFile}
        canShowMarkdownPreview={false}
        onOpenMarkdownPreview={vi.fn()}
        onOpenContainingFolder={vi.fn()}
      />
    )
    resolveOldListing([{ name: 'stale.ts', isDirectory: false, isSymlink: false }])

    await waitFor(() => expect(screen.queryByRole('button', { name: 'stale.ts' })).toBeNull())
    expect(screen.getByRole('button', { name: 'Browse README.md' })).toBeTruthy()
  })
})
