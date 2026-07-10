// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Tab } from '../../../../shared/types'
import type { AppState } from '../../store/types'

const { activateCyclableTabMock, getStateMock } = vi.hoisted(() => ({
  activateCyclableTabMock: vi.fn(),
  getStateMock: vi.fn()
}))

vi.mock('../../store', () => ({
  useAppStore: {
    getState: getStateMock
  }
}))

vi.mock('../../hooks/ipc-tab-switch', () => ({
  activateCyclableTab: activateCyclableTabMock
}))

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string) => fallback
}))

import RecentTabSwitcher from './RecentTabSwitcher'

const WORKTREE_ID = 'wt-1'
const GROUP_ID = 'group-1'

type CtrlTabKeyDownCallback = (data: { shiftKey: boolean }) => void
type CtrlTabKeyUpCallback = () => void

let ctrlTabKeyDownCallback: CtrlTabKeyDownCallback | null = null

function makeTab(id: string, entityId: string, label: string): Tab {
  return {
    id,
    entityId,
    groupId: GROUP_ID,
    worktreeId: WORKTREE_ID,
    contentType: 'editor',
    label,
    customLabel: null,
    color: null,
    sortOrder: 0,
    createdAt: 1
  }
}

function makeStore(): AppState {
  const tabs = [
    makeTab('tab-a', 'file-a', 'A'),
    makeTab('tab-b', 'file-b', 'B'),
    makeTab('tab-c', 'file-c', 'C')
  ]
  return {
    activeView: 'terminal',
    activeWorktreeId: WORKTREE_ID,
    activeBrowserTabId: null,
    activeFileId: 'file-a',
    activeGroupIdByWorktree: { [WORKTREE_ID]: GROUP_ID },
    activeTabId: null,
    activeTabType: 'editor',
    browserTabsByWorktree: {},
    groupsByWorktree: {
      [WORKTREE_ID]: [
        {
          id: GROUP_ID,
          worktreeId: WORKTREE_ID,
          activeTabId: 'tab-a',
          tabOrder: ['tab-a', 'tab-b', 'tab-c'],
          recentTabIds: ['tab-c', 'tab-b', 'tab-a']
        }
      ]
    },
    openFiles: tabs.map((tab) => ({
      id: tab.entityId,
      worktreeId: WORKTREE_ID,
      isDirty: false
    })),
    settings: { ctrlTabOrderMode: 'mru' },
    tabBarOrderByWorktree: {},
    tabsByWorktree: {},
    unifiedTabsByWorktree: { [WORKTREE_ID]: tabs }
  } as unknown as AppState
}

function installWindowApi(): void {
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      ui: {
        onCtrlTabKeyDown: vi.fn((callback: CtrlTabKeyDownCallback) => {
          ctrlTabKeyDownCallback = callback
          return vi.fn()
        }),
        onCtrlTabKeyUp: vi.fn((_callback: CtrlTabKeyUpCallback) => vi.fn())
      }
    }
  })
}

async function renderSwitcher(): Promise<{ container: HTMLDivElement; root: Root }> {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  await act(async () => {
    root.render(<RecentTabSwitcher />)
  })
  return { container, root }
}

function appendTerminalTextarea(): {
  input: HTMLTextAreaElement
  keyDown: ReturnType<typeof vi.fn>
  keyUp: ReturnType<typeof vi.fn>
} {
  const input = document.createElement('textarea')
  input.className = 'xterm-helper-textarea'
  const keyDown = vi.fn()
  const keyUp = vi.fn()
  input.addEventListener('keydown', keyDown)
  input.addEventListener('keyup', keyUp)
  document.body.appendChild(input)
  return { input, keyDown, keyUp }
}

async function dispatchKeyboard(
  target: HTMLElement,
  type: 'keydown' | 'keyup',
  init: KeyboardEventInit
): Promise<KeyboardEvent> {
  const event = new KeyboardEvent(type, {
    bubbles: true,
    cancelable: true,
    ...init
  })
  await act(async () => {
    target.dispatchEvent(event)
  })
  return event
}

function expectCommittedToTabB(): void {
  expect(activateCyclableTabMock).toHaveBeenCalledTimes(1)
  expect(activateCyclableTabMock.mock.calls[0][1]).toMatchObject({ key: 'tab-b', label: 'B' })
  expect(document.body.querySelector('[role="listbox"]')).toBeNull()
}

describe('RecentTabSwitcher', () => {
  beforeEach(() => {
    ctrlTabKeyDownCallback = null
    activateCyclableTabMock.mockReset()
    getStateMock.mockReturnValue(makeStore())
    installWindowApi()
  })

  afterEach(() => {
    document.body.innerHTML = ''
    vi.unstubAllGlobals()
  })

  it('commits the selected tab on modifier release before terminal input sees it', async () => {
    const { root } = await renderSwitcher()

    await act(async () => {
      ctrlTabKeyDownCallback?.({ shiftKey: false })
    })

    const terminal = appendTerminalTextarea()
    const event = await dispatchKeyboard(terminal.input, 'keyup', {
      key: 'Control',
      code: 'ControlLeft',
      ctrlKey: false
    })

    expect(event.defaultPrevented).toBe(true)
    expect(terminal.keyUp).not.toHaveBeenCalled()
    expectCommittedToTabB()

    await act(async () => {
      root.unmount()
    })
  })

  it('opens from DOM Ctrl+Tab and commits on DOM Ctrl release', async () => {
    const { root } = await renderSwitcher()
    const terminal = appendTerminalTextarea()

    const keyDown = await dispatchKeyboard(terminal.input, 'keydown', {
      key: 'Tab',
      code: 'Tab',
      ctrlKey: true
    })

    expect(keyDown.defaultPrevented).toBe(true)
    expect(terminal.keyDown).not.toHaveBeenCalled()
    expect(document.body.querySelector('[role="listbox"]')).not.toBeNull()

    const keyUp = await dispatchKeyboard(terminal.input, 'keyup', {
      key: 'Control',
      code: 'ControlLeft',
      ctrlKey: false
    })

    expect(keyUp.defaultPrevented).toBe(true)
    expect(terminal.keyUp).not.toHaveBeenCalled()
    expectCommittedToTabB()

    await act(async () => {
      root.unmount()
    })
  })
})
