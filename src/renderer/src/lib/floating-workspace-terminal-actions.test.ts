import { beforeEach, describe, expect, it, vi } from 'vitest'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../shared/constants'
import type { TerminalTab } from '../../../shared/types'
import {
  createFloatingWorkspaceTerminalTab,
  isFloatingWorkspacePanelFocused,
  isFloatingWorkspacePanelVisible,
  shouldMinimizeFloatingWorkspacePanelOnCloseShortcut
} from './floating-workspace-terminal-actions'

const createWebRuntimeSessionTerminalMock = vi.hoisted(() => vi.fn())
const focusTerminalTabSurfaceMock = vi.hoisted(() => vi.fn())

vi.mock('@/runtime/web-runtime-session', () => ({
  createWebRuntimeSessionTerminal: createWebRuntimeSessionTerminalMock
}))

vi.mock('./focus-terminal-tab-surface', () => ({
  focusTerminalTabSurface: focusTerminalTabSurfaceMock
}))

function makeTab(id: string): TerminalTab {
  return {
    id,
    ptyId: null,
    worktreeId: FLOATING_TERMINAL_WORKTREE_ID,
    title: 'Terminal',
    customTitle: null,
    color: null,
    sortOrder: 0,
    createdAt: 0
  }
}

describe('isFloatingWorkspacePanelVisible', () => {
  it('detects the visible floating workspace panel', () => {
    const doc = {
      querySelector: vi.fn().mockReturnValue({})
    }

    expect(isFloatingWorkspacePanelVisible(doc as never)).toBe(true)
    expect(doc.querySelector).toHaveBeenCalledWith(
      '[data-floating-terminal-panel][aria-hidden="false"]'
    )
  })

  it('returns false when the floating workspace panel is hidden or absent', () => {
    expect(isFloatingWorkspacePanelVisible({ querySelector: vi.fn().mockReturnValue(null) })).toBe(
      false
    )
  })
})

describe('isFloatingWorkspacePanelFocused', () => {
  it('detects focus inside the floating workspace panel', () => {
    const activeElement = {
      closest: vi.fn().mockReturnValue({})
    }
    vi.stubGlobal('HTMLElement', class {})

    Object.setPrototypeOf(activeElement, HTMLElement.prototype)

    expect(isFloatingWorkspacePanelFocused({ activeElement } as never)).toBe(true)
    expect(activeElement.closest).toHaveBeenCalledWith('[data-floating-terminal-panel]')

    vi.unstubAllGlobals()
  })
})

describe('createFloatingWorkspaceTerminalTab', () => {
  beforeEach(() => {
    createWebRuntimeSessionTerminalMock.mockReset()
    focusTerminalTabSurfaceMock.mockReset()
  })

  it('creates and focuses a local floating workspace terminal in the active floating group', async () => {
    const tab = makeTab('floating-tab-1')
    const store = {
      activeGroupIdByWorktree: { [FLOATING_TERMINAL_WORKTREE_ID]: 'floating-group' },
      settings: { activeRuntimeEnvironmentId: null },
      createTab: vi.fn().mockReturnValue(tab),
      activateTab: vi.fn()
    }
    createWebRuntimeSessionTerminalMock.mockResolvedValue(false)

    await expect(createFloatingWorkspaceTerminalTab(store as never)).resolves.toBe(tab)

    expect(createWebRuntimeSessionTerminalMock).toHaveBeenCalledWith({
      worktreeId: FLOATING_TERMINAL_WORKTREE_ID,
      environmentId: undefined,
      targetGroupId: 'floating-group',
      command: undefined,
      activate: true,
      selectWorktree: false
    })
    expect(store.createTab).toHaveBeenCalledWith(
      FLOATING_TERMINAL_WORKTREE_ID,
      'floating-group',
      undefined,
      { activate: false }
    )
    expect(store.activateTab).toHaveBeenCalledWith('floating-tab-1')
    expect(focusTerminalTabSurfaceMock).toHaveBeenCalledWith('floating-tab-1')
  })

  it('leaves local tabs untouched when the web runtime accepts the floating terminal', async () => {
    const store = {
      activeGroupIdByWorktree: {},
      settings: { activeRuntimeEnvironmentId: 'env-1' },
      createTab: vi.fn(),
      activateTab: vi.fn()
    }
    createWebRuntimeSessionTerminalMock.mockResolvedValue(true)

    await expect(createFloatingWorkspaceTerminalTab(store as never, 'pwsh')).resolves.toBeNull()

    expect(createWebRuntimeSessionTerminalMock).toHaveBeenCalledWith(
      expect.objectContaining({
        worktreeId: FLOATING_TERMINAL_WORKTREE_ID,
        environmentId: 'env-1',
        command: 'pwsh',
        selectWorktree: false
      })
    )
    expect(store.createTab).not.toHaveBeenCalled()
    expect(store.activateTab).not.toHaveBeenCalled()
    expect(focusTerminalTabSurfaceMock).not.toHaveBeenCalled()
  })
})

describe('shouldMinimizeFloatingWorkspacePanelOnCloseShortcut', () => {
  const base = {
    activeView: 'terminal',
    activeWorktreeId: null,
    floatingTerminalOpen: true,
    floatingUnifiedTabCount: 0
  }

  it('allows Cmd/Ctrl+W to minimize the empty floating panel from landing', () => {
    expect(shouldMinimizeFloatingWorkspacePanelOnCloseShortcut(base)).toBe(true)
  })

  it('does not minimize outside the empty floating-panel landing state', () => {
    expect(
      shouldMinimizeFloatingWorkspacePanelOnCloseShortcut({
        ...base,
        floatingUnifiedTabCount: 1
      })
    ).toBe(false)
    expect(
      shouldMinimizeFloatingWorkspacePanelOnCloseShortcut({
        ...base,
        activeWorktreeId: 'worktree-1'
      })
    ).toBe(false)
    expect(
      shouldMinimizeFloatingWorkspacePanelOnCloseShortcut({
        ...base,
        activeView: 'settings'
      })
    ).toBe(false)
    expect(
      shouldMinimizeFloatingWorkspacePanelOnCloseShortcut({
        ...base,
        floatingTerminalOpen: false
      })
    ).toBe(false)
  })
})
