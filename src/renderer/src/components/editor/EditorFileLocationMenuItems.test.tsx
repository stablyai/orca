// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { OpenFile } from '@/store/slices/editor'
import type { WorktreeRuntimeOwnerState } from '@/lib/worktree-runtime-owner-state'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { EditorFileLocationMenuItems } from './EditorFileLocationMenuItems'

const store = vi.hoisted((): { state: WorktreeRuntimeOwnerState } => ({ state: {} }))
vi.mock('@/store', () => ({
  useAppStore: (selector: (state: WorktreeRuntimeOwnerState) => unknown) => selector(store.state)
}))
vi.mock('@/i18n/i18n', () => ({ translate: (_key: string, fallback: string) => fallback }))

const openInFileManager = vi.fn().mockResolvedValue({ ok: true })
const writeClipboardText = vi.fn().mockResolvedValue(undefined)
const onCopyPath = vi.fn()
const file: OpenFile = {
  id: '/repo/src/file.ts',
  filePath: '/repo/src/file.ts',
  relativePath: 'src/file.ts',
  worktreeId: 'repo::/repo',
  language: 'typescript',
  mode: 'edit',
  isDirty: false
}

function renderMenu(overrides: Partial<OpenFile> = {}): void {
  render(
    <DropdownMenu open modal={false}>
      <DropdownMenuTrigger asChild>
        <button>File actions</button>
      </DropdownMenuTrigger>
      <DropdownMenuContent>
        <EditorFileLocationMenuItems file={{ ...file, ...overrides }} onCopyPath={onCopyPath} />
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

beforeEach(() => {
  store.state = {
    repos: [{ id: 'repo', connectionId: null }],
    worktreesByRepo: {
      repo: [{ id: file.worktreeId, repoId: 'repo', hostId: 'local' }]
    },
    folderWorkspaces: [],
    projectGroups: []
  }
  vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Macintosh')
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: { shell: { openInFileManager }, ui: { writeClipboardText } }
  })
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  vi.restoreAllMocks()
})

describe('EditorFileLocationMenuItems', () => {
  it('reveals the open file through the existing host-aware shell action', () => {
    renderMenu()
    fireEvent.click(screen.getByRole('menuitem', { name: 'Reveal in Finder' }))
    expect(openInFileManager).toHaveBeenCalledWith(file.filePath, 'local')
  })

  it('uses the header copy feedback and copies the workspace-relative path separately', () => {
    renderMenu()
    fireEvent.click(screen.getByRole('menuitem', { name: 'Copy Path' }))
    expect(onCopyPath).toHaveBeenCalledOnce()
    fireEvent.click(screen.getByRole('menuitem', { name: 'Copy Relative Path' }))
    expect(writeClipboardText).toHaveBeenCalledWith('src/file.ts')
  })

  it.each([{ externalSshTargetId: 'remote' }, { runtimeEnvironmentId: 'paired-server' }])(
    'disables local reveal for a remote file: %j',
    (overrides) => {
      renderMenu(overrides)
      const reveal = screen.getByRole('menuitem', { name: 'Reveal in Finder Local only' })
      expect(reveal.getAttribute('aria-disabled')).toBe('true')
      fireEvent.click(reveal)
      expect(openInFileManager).not.toHaveBeenCalled()
      expect(
        screen.getByRole('menuitem', { name: 'Copy Relative Path' }).hasAttribute('data-disabled')
      ).toBe(false)
    }
  )

  it('refuses local reveal while the owning workspace is unresolved', () => {
    store.state = { repos: [], worktreesByRepo: {}, folderWorkspaces: [], projectGroups: [] }
    renderMenu()
    expect(
      screen.getByRole('menuitem', { name: /Reveal in Finder/ }).getAttribute('aria-disabled')
    ).toBe('true')
  })

  it('reveals local files even while a remote runtime is selected', () => {
    store.state.settings = { activeRuntimeEnvironmentId: 'paired-server' }
    renderMenu()
    fireEvent.click(screen.getByRole('menuitem', { name: 'Reveal in Finder' }))
    expect(openInFileManager).toHaveBeenCalledWith(file.filePath, 'local')
  })

  it('reveals a file in a folder workspace without a git worktree', () => {
    store.state = {
      repos: [],
      worktreesByRepo: {},
      folderWorkspaces: [{ id: 'folder', projectGroupId: 'group', executionHostId: 'local' }],
      projectGroups: [{ id: 'group', connectionId: null }]
    }
    renderMenu({ worktreeId: 'folder:folder' })
    fireEvent.click(screen.getByRole('menuitem', { name: 'Reveal in Finder' }))
    expect(openInFileManager).toHaveBeenCalledWith(file.filePath, 'local')
  })
})
