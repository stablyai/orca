import { beforeEach, describe, expect, it, vi } from 'vitest'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../../../../shared/constants'
import { createPluginNewFileActions } from './untitled-file-creation'
import type { AppState } from '../../../types'
import type { createUntitledMarkdownFile } from '@/lib/create-untitled-markdown'

const createFile = vi.hoisted(() => vi.fn<typeof createUntitledMarkdownFile>())

vi.mock('@/lib/create-untitled-markdown', () => ({ createUntitledMarkdownFile: createFile }))

const newFile = { pluginKey: 'local.todos', id: 'todo', title: 'Todo', extension: '.orca-todo' }

function setup(floatingGroupIds: string[]) {
  const openFile = vi.fn<AppState['openFile']>()
  const state = {
    groupsByWorktree: {
      [FLOATING_TERMINAL_WORKTREE_ID]: floatingGroupIds.map((id) => ({
        id,
        worktreeId: FLOATING_TERMINAL_WORKTREE_ID,
        activeTabId: null,
        tabOrder: []
      }))
    },
    openFile
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the action only reads the stubbed fields
  const get = (): AppState => state as unknown as AppState
  return { openFile, actions: createPluginNewFileActions(vi.fn(), get) }
}

beforeEach(() => {
  vi.clearAllMocks()
  createFile.mockImplementation(async (directory, worktreeId) => ({
    filePath: `${directory}/untitled.orca-todo`,
    relativePath: 'untitled.orca-todo',
    worktreeId,
    language: 'plaintext',
    isUntitled: true,
    mode: 'edit'
  }))
  vi.stubGlobal('window', {
    api: {
      app: { getFloatingMarkdownDirectory: async () => '/floating-notes' },
      plugins: { readNewFileTemplate: async () => '{}' }
    }
  })
})

describe('plugin new-file destination', () => {
  it('creates files from a floating group in the floating workspace', async () => {
    const { actions, openFile } = setup(['floating-group'])
    await actions.openNewPluginFileInActiveWorkspace(newFile, 'floating-group')
    expect(openFile).toHaveBeenCalledWith(
      expect.objectContaining({
        worktreeId: FLOATING_TERMINAL_WORKTREE_ID,
        filePath: '/floating-notes/untitled.orca-todo'
      }),
      {
        preview: false,
        targetGroupId: 'floating-group',
        focusEditor: true,
        suppressActiveRuntimeFallback: true
      }
    )
  })

  it('routes an empty floating panel to the floating workspace without a target group', async () => {
    const { actions, openFile } = setup([])
    await actions.openNewPluginFileInActiveWorkspace(newFile, FLOATING_TERMINAL_WORKTREE_ID)
    expect(openFile).toHaveBeenCalledWith(
      expect.objectContaining({ worktreeId: FLOATING_TERMINAL_WORKTREE_ID }),
      {
        preview: false,
        targetGroupId: undefined,
        focusEditor: true,
        suppressActiveRuntimeFallback: true
      }
    )
  })
})
