// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppState } from '@/store/types'
import { makeWorktree } from '@/store/slices/worktrees/worktree.test-fixture'
import { makeFolderWorkspace } from '@/store/folder-workspaces/folder-workspace.test-fixture'
import { TEST_REPO } from '@/store/repos/repo.test-fixture'

const mocks = vi.hoisted(() => ({
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: replaced before each test with every store field read by these shortcut callers.
  state: {} as AppState,
  deleteWorktree: vi.fn(),
  folder: vi.fn()
}))
vi.mock('@/store', () => ({ useAppStore: { getState: () => mocks.state } }))
vi.mock('./delete-worktree-flow', () => ({ runWorktreeDelete: mocks.deleteWorktree }))
vi.mock('./folder-workspace-delete', () => ({ deleteFolderWorkspaceUnlessUnsaved: mocks.folder }))
vi.mock('@/components/floating-terminal/floating-workspace-terminal-actions', () => ({
  isFloatingWorkspacePanelFocused: () => false
}))
import { createAppCommandHandlers, type AppShortcutState } from '@/app-shell/app-command-handlers'
import { registerWorkspaceShortcutIpcBridge } from '@/hooks/ipc-events/workspace-shortcut-ipc-bridge'
import {
  createWorktreeContextMenuDeleteIntent,
  runWorktreeContextMenuDeleteIntent
} from '../context-menu/worktree-context-menu-delete-intent'

const active = makeWorktree({ id: 'active', repoId: 'repo1', hostId: 'local', instanceId: 'a' })
const other = makeWorktree({ id: 'other', repoId: 'repo1', hostId: 'local', instanceId: 'b' })
let ipcDelete: () => void

function runRenderer(): void {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: delete uses store state; unrelated shortcut actions are never invoked.
  const state = {
    activeView: 'terminal',
    activeWorktreeId: 'active',
    actions: {},
    creationLayoutActive: false,
    floatingTerminalEnabled: false,
    floatingTerminalOpen: false,
    floatingVisibleTabCount: 0,
    keybindings: {},
    openFloatingWorkspaceMaximized: vi.fn(),
    pluginCommands: [],
    setFloatingTerminalOpen: vi.fn(),
    terminalShortcutPolicy: 'orca-first',
    workspaceChromeActive: true
  } as AppShortcutState
  createAppCommandHandlers(state, undefined, 'app', true).get('workspace.delete')?.()
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.folder.mockReturnValue(null)
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: this isolated store mock supplies every field read by the tested production paths.
  mocks.state = {
    activeView: 'terminal',
    activeModal: 'none',
    activeWorktreeId: 'active',
    activeWorkspaceExecutionHostId: 'local',
    activePendingCreationId: null,
    pendingWorktreeCreations: {},
    repos: [TEST_REPO],
    worktreesByRepo: { repo1: [active, other] },
    folderWorkspaces: [],
    projectGroups: [],
    deleteStateByWorktreeId: {}
  } as unknown as AppState
  const noop = () => () => {}
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      ui: {
        onOpenQuickOpen: noop,
        onToggleQuickCommandsMenu: noop,
        onOpenNewWorkspace: noop,
        onDeleteCurrentWorkspace: (callback: () => void) => {
          ipcDelete = callback
          return () => {}
        },
        onOpenTasks: noop,
        onJumpToWorktreeIndex: noop,
        onJumpToTabIndex: noop,
        onWorktreeHistoryNavigate: noop,
        onToggleStatusBar: noop
      }
    }
  })
  registerWorkspaceShortcutIpcBridge([])
  const query = document.querySelectorAll.bind(document)
  vi.spyOn(document, 'querySelectorAll').mockImplementation((selector) =>
    query(selector.replace(':hover', '[data-hovered]'))
  )
  document.body.innerHTML =
    '<div data-worktree-sidebar><div role="option" data-worktree-id="other" data-worktree-host-identity="local|other" data-hovered></div></div>'
})
afterEach(() => {
  document.body.innerHTML = ''
  vi.restoreAllMocks()
})

describe.each([
  ['renderer', runRenderer],
  ['main IPC', () => ipcDelete()]
] as const)('%s delete shortcut', (_name, run) => {
  it('targets the active instance while a different row is hovered, but menu clicks keep their row', () => {
    run()
    expect(mocks.deleteWorktree).toHaveBeenCalledExactlyOnceWith('active', {
      expectedHostId: 'local',
      expectedInstanceId: 'a'
    })
    runWorktreeContextMenuDeleteIntent(
      createWorktreeContextMenuDeleteIntent({
        worktree: other,
        batchDeleteWorktrees: [],
        isMultiContext: false
      })
    )
    expect(mocks.deleteWorktree).toHaveBeenLastCalledWith('other', {
      expectedHostId: 'local',
      expectedInstanceId: 'b'
    })
  })

  it('works with no sidebar or hovered row', () => {
    document.body.innerHTML = ''
    run()
    expect(mocks.deleteWorktree).toHaveBeenCalledExactlyOnceWith('active', {
      expectedHostId: 'local',
      expectedInstanceId: 'a'
    })
  })

  it('pins the active host when another host publishes the same ID', () => {
    mocks.state.worktreesByRepo = {
      repo1: [active, { ...active, hostId: 'ssh:builder', instanceId: 'remote' }]
    }
    mocks.state.activeWorkspaceExecutionHostId = 'ssh:builder'
    run()
    expect(mocks.deleteWorktree).toHaveBeenCalledExactlyOnceWith('active', {
      expectedHostId: 'ssh:builder',
      expectedInstanceId: 'remote'
    })
  })

  it('resolves legacy local ownership without inventing a stamped host', () => {
    mocks.state.worktreesByRepo = { repo1: [{ ...active, hostId: undefined }] }
    run()
    expect(mocks.deleteWorktree).toHaveBeenCalledExactlyOnceWith('active', {
      expectedInstanceId: 'a'
    })
  })

  it('keeps a paired logical host bound to its physical row', () => {
    mocks.state.worktreesByRepo = {
      repo1: [{ ...active, hostId: 'ssh:builder', runtimeOwnerEnvironmentId: 'build' }]
    }
    mocks.state.activeWorkspaceExecutionHostId = 'runtime:build'
    run()
    expect(mocks.deleteWorktree).toHaveBeenCalledExactlyOnceWith('active', {
      expectedHostId: 'ssh:builder',
      expectedInstanceId: 'a'
    })
  })

  it('refuses an ambiguous unqualified active ID', () => {
    mocks.state.activeWorkspaceExecutionHostId = null
    mocks.state.worktreesByRepo = { repo1: [active, { ...active, hostId: 'ssh:builder' }] }
    run()
    expect(mocks.deleteWorktree).not.toHaveBeenCalled()
  })

  it('routes the active folder to its qualified owner', () => {
    mocks.state.activeWorktreeId = 'folder:folder-1'
    mocks.state.activeWorkspaceExecutionHostId = 'ssh:builder'
    mocks.state.folderWorkspaces = [
      makeFolderWorkspace({ executionHostId: 'local' }),
      makeFolderWorkspace({ executionHostId: 'ssh:builder' })
    ]
    run()
    expect(mocks.folder).toHaveBeenCalledExactlyOnceWith(
      expect.any(Function),
      'folder-1',
      'ssh:builder'
    )
    expect(mocks.deleteWorktree).not.toHaveBeenCalled()
  })

  it.each(['settings', 'activity', 'space', 'tasks'] as const)(
    'refuses behind the %s view',
    (activeView) => {
      mocks.state.activeView = activeView
      run()
      expect(mocks.deleteWorktree).not.toHaveBeenCalled()
    }
  )

  it('refuses while a creation surface owns the workspace', () => {
    mocks.state.activePendingCreationId = 'pending'
    mocks.state.pendingWorktreeCreations = {
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: creation eligibility reads only status and loaderVisible.
      pending: {
        status: 'error',
        loaderVisible: true
      } as AppState['pendingWorktreeCreations'][string]
    }
    run()
    expect(mocks.deleteWorktree).not.toHaveBeenCalled()
  })

  it('refuses a local dialog with button focus even when activeModal is none', () => {
    const dialog = document.createElement('div')
    dialog.role = 'dialog'
    dialog.innerHTML = '<button>Cancel</button>'
    document.body.append(dialog)
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: overlay visibility reads only the returned rectangle count.
    vi.spyOn(dialog, 'getClientRects').mockReturnValue([
      new DOMRect(0, 0, 300, 200)
    ] as unknown as DOMRectList)
    dialog.querySelector('button')?.focus()
    run()
    expect(mocks.deleteWorktree).not.toHaveBeenCalled()
  })

  it('allows an ordinary context menu without changing the active target', () => {
    document.body.insertAdjacentHTML(
      'beforeend',
      '<div role="menu"><button role="menuitem">Delete</button></div>'
    )
    const menu = document.querySelector('[role="menu"]')
    if (!menu) {
      throw new Error('Missing menu')
    }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: overlay visibility reads only the returned rectangle count.
    vi.spyOn(menu, 'getClientRects').mockReturnValue([
      new DOMRect(0, 0, 300, 200)
    ] as unknown as DOMRectList)
    document.querySelector('button')?.focus()
    run()
    expect(mocks.deleteWorktree).toHaveBeenCalledExactlyOnceWith('active', {
      expectedHostId: 'local',
      expectedInstanceId: 'a'
    })
  })

  it.each(['missing', 'primary', 'deleting', 'modal', 'editable'] as const)(
    'refuses %s targets or focus',
    (guard) => {
      if (guard === 'missing') {
        mocks.state.activeWorktreeId = 'missing'
      }
      if (guard === 'primary') {
        mocks.state.worktreesByRepo = { repo1: [{ ...active, isMainWorktree: true }] }
      }
      if (guard === 'deleting') {
        mocks.state.deleteStateByWorktreeId = {
          'local|active': {
            isDeleting: true,
            error: null,
            canForceDelete: false,
            forceDeleteReason: null
          }
        }
      }
      if (guard === 'modal') {
        mocks.state.activeModal = 'delete-worktree'
      }
      if (guard === 'editable') {
        document.body.insertAdjacentHTML('beforeend', '<input>')
        document.querySelector('input')?.focus()
      }
      run()
      expect(mocks.deleteWorktree).not.toHaveBeenCalled()
    }
  )
})
