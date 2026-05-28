/* eslint-disable max-lines -- Focus, shortcut, creation, and switching cases share
 * the same floating-workspace DOM/store fixtures. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../shared/constants'
import type { Tab, TerminalTab } from '../../../shared/types'
import {
  createFloatingWorkspaceTerminalTab,
  isFloatingWorkspacePanelFocused,
  isFloatingWorkspacePanelShortcut,
  isFloatingWorkspacePanelShortcutTarget,
  isFloatingWorkspaceTerminalInputTarget,
  isFloatingWorkspacePanelVisible,
  shouldMinimizeFloatingWorkspacePanelOnCloseShortcut,
  switchFloatingWorkspaceTab
} from './floating-workspace-terminal-actions'

const activateWebRuntimeSessionTabMock = vi.hoisted(() => vi.fn())
const createWebRuntimeSessionTerminalMock = vi.hoisted(() => vi.fn())
const focusTerminalTabSurfaceMock = vi.hoisted(() => vi.fn())
const isWebRuntimeSessionActiveMock = vi.hoisted(() => vi.fn())

vi.mock('@/runtime/web-runtime-session', () => ({
  activateWebRuntimeSessionTab: activateWebRuntimeSessionTabMock,
  createWebRuntimeSessionTerminal: createWebRuntimeSessionTerminalMock,
  isWebRuntimeSessionActive: isWebRuntimeSessionActiveMock
}))

vi.mock('./focus-terminal-tab-surface', () => ({
  focusTerminalTabSurface: focusTerminalTabSurfaceMock
}))

function shortcutEvent(overrides: Partial<KeyboardEvent>): KeyboardEvent {
  return {
    altKey: false,
    ctrlKey: false,
    key: 't',
    metaKey: false,
    shiftKey: false,
    ...overrides
  } as KeyboardEvent
}

function shortcutSurfaceEvent(overrides: Partial<KeyboardEvent>): KeyboardEvent {
  return shortcutEvent({
    target: makeElement({
      closestSelectors: ['[data-floating-terminal-shortcut-surface]']
    }),
    ...overrides
  })
}

function installFakeHTMLElement(): void {
  vi.stubGlobal('HTMLElement', class {})
}

function makeElement({
  attributes = [],
  classNames = [],
  closestSelectors = []
}: {
  attributes?: string[]
  classNames?: string[]
  closestSelectors?: string[]
}): HTMLElement {
  const element = {
    classList: {
      contains: vi.fn((token: string) => classNames.includes(token))
    },
    getAttribute: vi.fn((attribute: string) => (attributes.includes(attribute) ? '' : null)),
    closest: vi.fn((selector: string) => (closestSelectors.includes(selector) ? {} : null))
  }
  Object.setPrototypeOf(element, HTMLElement.prototype)
  return element as unknown as HTMLElement
}

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

function makeUnifiedTerminalTab(id: string, groupId = 'floating-group'): Tab {
  return {
    id,
    entityId: id,
    groupId,
    worktreeId: FLOATING_TERMINAL_WORKTREE_ID,
    contentType: 'terminal',
    label: 'Terminal',
    customLabel: null,
    color: null,
    sortOrder: 0,
    createdAt: 0
  }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

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
    installFakeHTMLElement()
    const activeElement = makeElement({
      closestSelectors: ['[data-floating-terminal-panel]']
    })

    expect(isFloatingWorkspacePanelFocused({ activeElement } as never)).toBe(true)
    expect(activeElement.closest).toHaveBeenCalledWith('[data-floating-terminal-panel]')
  })

  it('ignores focus outside the floating workspace panel', () => {
    installFakeHTMLElement()
    const activeElement = makeElement({})

    expect(isFloatingWorkspacePanelFocused({ activeElement } as never)).toBe(false)
  })
})

describe('isFloatingWorkspaceTerminalInputTarget', () => {
  it('detects the xterm helper textarea inside the floating panel', () => {
    installFakeHTMLElement()
    const target = makeElement({
      classNames: ['xterm-helper-textarea'],
      closestSelectors: ['[data-floating-terminal-panel]']
    })

    expect(isFloatingWorkspaceTerminalInputTarget(target)).toBe(true)
  })

  it('detects targets inside xterm DOM inside the floating panel', () => {
    installFakeHTMLElement()
    const target = makeElement({
      closestSelectors: ['[data-floating-terminal-panel]', '.xterm']
    })

    expect(isFloatingWorkspaceTerminalInputTarget(target)).toBe(true)
  })

  it('ignores terminal input outside the floating panel', () => {
    installFakeHTMLElement()
    const target = makeElement({
      classNames: ['xterm-helper-textarea']
    })

    expect(isFloatingWorkspaceTerminalInputTarget(target)).toBe(false)
  })

  it('ignores non-terminal targets inside the floating panel', () => {
    installFakeHTMLElement()
    const target = makeElement({
      closestSelectors: ['[data-floating-terminal-panel]']
    })

    expect(isFloatingWorkspaceTerminalInputTarget(target)).toBe(false)
  })
})

describe('isFloatingWorkspacePanelShortcut', () => {
  beforeEach(() => {
    installFakeHTMLElement()
  })

  it.each([
    ['Cmd+T', true, { key: 't', metaKey: true }],
    ['Ctrl+T', false, { key: 't', ctrlKey: true }],
    ['Cmd+W', true, { key: 'w', metaKey: true }],
    ['Ctrl+W', false, { key: 'w', ctrlKey: true }],
    ['Cmd+Shift+B', true, { key: 'b', metaKey: true, shiftKey: true }],
    ['Ctrl+Shift+B', false, { key: 'b', ctrlKey: true, shiftKey: true }],
    ['Cmd+Shift+M', true, { key: 'm', metaKey: true, shiftKey: true }],
    ['Ctrl+Shift+M', false, { key: 'm', ctrlKey: true, shiftKey: true }],
    ['Cmd+Shift+O', true, { key: 'o', metaKey: true, shiftKey: true }],
    ['Ctrl+Shift+O', false, { key: 'o', ctrlKey: true, shiftKey: true }]
  ])('claims %s', (_label, isMacPlatform, overrides) => {
    expect(isFloatingWorkspacePanelShortcut(shortcutSurfaceEvent(overrides), isMacPlatform)).toBe(
      true
    )
  })

  it.each([
    ['Cmd+B', true, { key: 'b', metaKey: true }],
    ['Ctrl+B', false, { key: 'b', ctrlKey: true }]
  ])('does not claim bare %s', (_label, isMacPlatform, overrides) => {
    expect(isFloatingWorkspacePanelShortcut(shortcutSurfaceEvent(overrides), isMacPlatform)).toBe(
      false
    )
  })

  it('claims shortcuts by produced logical key rather than physical key', () => {
    expect(
      isFloatingWorkspacePanelShortcut(
        shortcutSurfaceEvent({ key: 'w', code: 'Comma', metaKey: true }),
        'darwin'
      )
    ).toBe(true)
    expect(
      isFloatingWorkspacePanelShortcut(
        shortcutSurfaceEvent({ key: ',', code: 'KeyW', metaKey: true }),
        'darwin'
      )
    ).toBe(false)
  })

  it('honors customized tab shortcuts for the floating panel surface', () => {
    expect(
      isFloatingWorkspacePanelShortcut(
        shortcutSurfaceEvent({ key: 'n', code: 'KeyN', ctrlKey: true }),
        'linux',
        null,
        { 'tab.newTerminal': ['Ctrl+N'] }
      )
    ).toBe(true)
    expect(
      isFloatingWorkspacePanelShortcut(
        shortcutSurfaceEvent({ key: 't', code: 'KeyT', ctrlKey: true }),
        'linux',
        null,
        { 'tab.newTerminal': ['Ctrl+N'] }
      )
    ).toBe(false)
  })

  it('does not claim shortcuts with Alt or the wrong platform modifier', () => {
    expect(
      isFloatingWorkspacePanelShortcut(shortcutSurfaceEvent({ key: 't', metaKey: true }), false)
    ).toBe(false)
    expect(
      isFloatingWorkspacePanelShortcut(shortcutSurfaceEvent({ key: 't', ctrlKey: true }), true)
    ).toBe(false)
    expect(
      isFloatingWorkspacePanelShortcut(
        shortcutSurfaceEvent({ key: 't', ctrlKey: true, altKey: true }),
        false
      )
    ).toBe(false)
  })

  it('only claims shortcuts from the panel root or shortcut surface', () => {
    const panelRoot = makeElement({
      attributes: ['data-floating-terminal-panel'],
      closestSelectors: ['[data-floating-terminal-panel]']
    })
    const panelContent = makeElement({
      closestSelectors: ['[data-floating-terminal-panel]']
    })

    expect(isFloatingWorkspacePanelShortcutTarget(panelRoot, panelRoot)).toBe(true)
    expect(
      isFloatingWorkspacePanelShortcut(
        shortcutEvent({ key: 't', ctrlKey: true, target: panelRoot }),
        false
      )
    ).toBe(true)
    expect(
      isFloatingWorkspacePanelShortcut(
        shortcutEvent({ key: 't', ctrlKey: true, target: panelContent }),
        false,
        panelRoot
      )
    ).toBe(false)
  })
})

describe('createFloatingWorkspaceTerminalTab', () => {
  beforeEach(() => {
    activateWebRuntimeSessionTabMock.mockReset()
    createWebRuntimeSessionTerminalMock.mockReset()
    focusTerminalTabSurfaceMock.mockReset()
    isWebRuntimeSessionActiveMock.mockReset()
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

describe('switchFloatingWorkspaceTab', () => {
  beforeEach(() => {
    activateWebRuntimeSessionTabMock.mockReset()
    focusTerminalTabSurfaceMock.mockReset()
    isWebRuntimeSessionActiveMock.mockReset()
    isWebRuntimeSessionActiveMock.mockReturnValue(false)
  })

  it('cycles terminal tabs inside the floating workspace active group', () => {
    const store = {
      activeGroupIdByWorktree: { [FLOATING_TERMINAL_WORKTREE_ID]: 'floating-group' },
      activateTab: vi.fn(),
      browserPagesByWorkspace: {},
      browserTabsByWorktree: {},
      groupsByWorktree: {
        [FLOATING_TERMINAL_WORKTREE_ID]: [
          {
            id: 'floating-group',
            worktreeId: FLOATING_TERMINAL_WORKTREE_ID,
            activeTabId: 'tab-1',
            tabOrder: ['tab-1', 'tab-2'],
            recentTabIds: ['tab-1']
          }
        ]
      },
      openFiles: [],
      setActiveTab: vi.fn(),
      settings: { activeRuntimeEnvironmentId: null },
      tabsByWorktree: {
        [FLOATING_TERMINAL_WORKTREE_ID]: [makeTab('tab-1'), makeTab('tab-2')]
      },
      unifiedTabsByWorktree: {
        [FLOATING_TERMINAL_WORKTREE_ID]: [
          makeUnifiedTerminalTab('tab-1'),
          makeUnifiedTerminalTab('tab-2')
        ]
      }
    }

    expect(switchFloatingWorkspaceTab(store as never, 1, 'same-type')).toBe(true)

    expect(store.activateTab).toHaveBeenCalledWith('tab-2')
    expect(store.setActiveTab).toHaveBeenCalledWith('tab-2')
    expect(focusTerminalTabSurfaceMock).toHaveBeenCalledWith('tab-2')
    expect(activateWebRuntimeSessionTabMock).not.toHaveBeenCalled()
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
