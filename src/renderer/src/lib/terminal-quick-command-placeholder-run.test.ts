import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { OpenFile } from '@/store/slices/editor'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../shared/constants'
import type { FolderWorkspace } from '../../../shared/folder-workspace-types'
import type { Worktree } from '../../../shared/worktree/types'
import { folderWorkspaceKey } from '../../../shared/workspace-scope'
import { worktreeFixture } from '../components/native-chat/native-chat-workspace-test-fixtures'
import { makeFolderWorkspace } from '@/store/slices/worktrees-slice-test-fixtures'
import {
  prepareTerminalQuickCommandForRun,
  resolveTerminalQuickCommandPlaceholderContext
} from './terminal-quick-command-placeholder-run'

const toastMessage = vi.hoisted(() => vi.fn())

vi.mock('sonner', () => ({
  toast: { message: toastMessage }
}))

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string) => fallback
}))

type PlaceholderFile = Pick<
  OpenFile,
  | 'id'
  | 'filePath'
  | 'relativePath'
  | 'worktreeId'
  | 'mode'
  | 'isUntitled'
  | 'csvPreviewOnly'
  | 'checkRunDetails'
>

type PlaceholderStoreState = {
  openFiles: PlaceholderFile[]
  activeFileIdByWorktree: Record<string, string | null>
  worktreesByRepo: Record<string, Worktree[]>
  folderWorkspaces: FolderWorkspace[]
  floatingWorkspacePath: string | null
}

const storeState = vi.hoisted(() => {
  const current: PlaceholderStoreState = {
    openFiles: [],
    activeFileIdByWorktree: {},
    worktreesByRepo: {},
    folderWorkspaces: [],
    floatingWorkspacePath: null
  }
  return { current }
})

vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => storeState.current
  }
}))

function editorFile(overrides: Partial<PlaceholderFile> = {}): PlaceholderFile {
  return {
    id: '/repo/src/app.py',
    filePath: '/repo/src/app.py',
    relativePath: 'src/app.py',
    worktreeId: 'wt-1',
    mode: 'edit',
    isUntitled: false,
    csvPreviewOnly: false,
    checkRunDetails: undefined,
    ...overrides
  }
}

function catalog(overrides: Partial<PlaceholderStoreState> = {}): PlaceholderStoreState {
  return {
    openFiles: [],
    activeFileIdByWorktree: {},
    worktreesByRepo: {},
    folderWorkspaces: [],
    floatingWorkspacePath: null,
    ...overrides
  }
}

describe('resolveTerminalQuickCommandPlaceholderContext', () => {
  it('uses the worktree path and the active edit file', () => {
    const context = resolveTerminalQuickCommandPlaceholderContext(
      catalog({
        openFiles: [editorFile()],
        activeFileIdByWorktree: { 'wt-1': '/repo/src/app.py' },
        worktreesByRepo: { repo: [worktreeFixture('wt-1', '/repo')] }
      }),
      'wt-1'
    )
    expect(context).toEqual({
      filePath: '/repo/src/app.py',
      relativePath: 'src/app.py',
      workspaceFolder: '/repo'
    })
  })

  it('ignores untitled, diff, csv, check-details, and other-worktree tabs', () => {
    const untitled = resolveTerminalQuickCommandPlaceholderContext(
      catalog({
        openFiles: [editorFile({ isUntitled: true })],
        activeFileIdByWorktree: { 'wt-1': '/repo/src/app.py' },
        worktreesByRepo: { repo: [worktreeFixture('wt-1', '/repo')] }
      }),
      'wt-1'
    )
    expect(untitled.filePath).toBeNull()
    expect(untitled.workspaceFolder).toBe('/repo')

    const diff = resolveTerminalQuickCommandPlaceholderContext(
      catalog({
        openFiles: [editorFile({ mode: 'diff' })],
        activeFileIdByWorktree: { 'wt-1': '/repo/src/app.py' },
        worktreesByRepo: { repo: [worktreeFixture('wt-1', '/repo')] }
      }),
      'wt-1'
    )
    expect(diff.filePath).toBeNull()

    const csv = resolveTerminalQuickCommandPlaceholderContext(
      catalog({
        openFiles: [editorFile({ csvPreviewOnly: true })],
        activeFileIdByWorktree: { 'wt-1': '/repo/src/app.py' },
        worktreesByRepo: { repo: [worktreeFixture('wt-1', '/repo')] }
      }),
      'wt-1'
    )
    expect(csv.filePath).toBeNull()

    const checkDetails = resolveTerminalQuickCommandPlaceholderContext(
      catalog({
        openFiles: [editorFile({ mode: 'check-details' })],
        activeFileIdByWorktree: { 'wt-1': '/repo/src/app.py' },
        worktreesByRepo: { repo: [worktreeFixture('wt-1', '/repo')] }
      }),
      'wt-1'
    )
    expect(checkDetails.filePath).toBeNull()

    const otherWorktree = resolveTerminalQuickCommandPlaceholderContext(
      catalog({
        openFiles: [editorFile({ worktreeId: 'wt-2' })],
        activeFileIdByWorktree: { 'wt-1': '/repo/src/app.py' },
        worktreesByRepo: { repo: [worktreeFixture('wt-1', '/repo')] }
      }),
      'wt-1'
    )
    expect(otherWorktree.filePath).toBeNull()
  })

  it('derives the workspace folder from the file when the worktree is missing', () => {
    const context = resolveTerminalQuickCommandPlaceholderContext(
      catalog({
        openFiles: [editorFile()],
        activeFileIdByWorktree: { 'wt-1': '/repo/src/app.py' }
      }),
      'wt-1'
    )
    expect(context.workspaceFolder).toBe('/repo')
  })

  it('resolves a folder workspace directory without a git worktree row', () => {
    const folderId = 'folder-1'
    const context = resolveTerminalQuickCommandPlaceholderContext(
      catalog({
        folderWorkspaces: [makeFolderWorkspace({ id: folderId, folderPath: '/notes' })]
      }),
      folderWorkspaceKey(folderId)
    )
    expect(context).toEqual({
      filePath: null,
      relativePath: null,
      workspaceFolder: '/notes'
    })
  })

  it('resolves the floating workspace directory', () => {
    const context = resolveTerminalQuickCommandPlaceholderContext(
      catalog({ floatingWorkspacePath: '/tmp/float' }),
      FLOATING_TERMINAL_WORKTREE_ID
    )
    expect(context.workspaceFolder).toBe('/tmp/float')
  })
})

describe('prepareTerminalQuickCommandForRun', () => {
  beforeEach(() => {
    toastMessage.mockReset()
    storeState.current = catalog({
      openFiles: [editorFile()],
      activeFileIdByWorktree: { 'wt-1': '/repo/src/app.py' },
      worktreesByRepo: { repo: [worktreeFixture('wt-1', '/repo')] }
    })
  })

  it('leaves commands without placeholders unchanged', () => {
    const command = {
      id: 'status',
      label: 'Status',
      command: 'git status',
      appendEnter: true
    }
    expect(prepareTerminalQuickCommandForRun(command, 'wt-1')).toBe(command)
    expect(toastMessage).not.toHaveBeenCalled()
  })

  it('substitutes the active editor path before the command is sent', () => {
    expect(
      prepareTerminalQuickCommandForRun(
        {
          id: 'run',
          label: 'Run file',
          command: 'python "${file}"',
          appendEnter: true
        },
        'wt-1'
      )
    ).toEqual({
      id: 'run',
      label: 'Run file',
      command: 'python "/repo/src/app.py"',
      appendEnter: true
    })
  })

  it('refuses to run when a file token is present and no editor file is active', () => {
    storeState.current = catalog({
      worktreesByRepo: { repo: [worktreeFixture('wt-1', '/repo')] }
    })

    expect(
      prepareTerminalQuickCommandForRun(
        {
          id: 'run',
          label: 'Run file',
          command: 'python "${file}"',
          appendEnter: true
        },
        'wt-1'
      )
    ).toBeNull()
    expect(toastMessage).toHaveBeenCalledWith(
      'This command needs an editor file. Open a file in this workspace and try again.'
    )
  })

  it('refuses to run when ${workspaceFolder} cannot be resolved', () => {
    storeState.current = catalog()

    expect(
      prepareTerminalQuickCommandForRun(
        {
          id: 'cd-root',
          label: 'Workspace root',
          command: 'cd ${workspaceFolder}',
          appendEnter: true
        },
        'wt-1'
      )
    ).toBeNull()
    expect(toastMessage).toHaveBeenCalledWith(
      'This command needs the workspace folder, which is not available here.'
    )
  })
})
