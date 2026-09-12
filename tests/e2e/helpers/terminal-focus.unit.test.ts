import { afterEach, expect, it, vi } from 'vitest'
import type { Page } from '@stablyai/playwright-test'

vi.mock('@stablyai/playwright-test', () => ({
  expect: {
    poll: (read: () => Promise<boolean>) => ({
      toBe: async (expected: boolean) => {
        for (let attempt = 0; attempt < 3; attempt++) {
          if ((await read()) === expected) {
            return
          }
        }
        throw new Error('not focusable')
      }
    })
  }
}))
vi.mock('./terminal-pane-identity', () => ({
  resolveActiveTabId: async () => 'folder-tab'
}))

import { focusActiveTerminalInput } from './terminal'

afterEach(() => vi.unstubAllGlobals())

function fixture() {
  const document = { activeElement: null as unknown }
  const textarea = {
    checkVisibility: vi.fn(() => true),
    focus: vi.fn(() => {
      document.activeElement = textarea
    })
  }
  const pane = {
    container: { isConnected: true, querySelector: () => textarea },
    terminal: { focus: vi.fn() }
  }
  const state = {
    activeWorktreeId: 'folder:one',
    activeTabId: 'old-worktree-tab',
    activeTabType: 'terminal',
    tabsByWorktree: { 'folder:one': [{ id: 'folder-tab' }] },
    setActiveTab: vi.fn(),
    setActiveTabType: vi.fn()
  }
  vi.stubGlobal('document', document)
  vi.stubGlobal('window', {
    __store: { getState: () => state },
    __paneManagers: new Map([['folder-tab', { getActivePane: () => pane }]])
  })
  const evaluate = vi.fn(async (read: (id: string) => boolean, id: string) => read(id))
  return { state, pane, textarea, evaluate, page: { evaluate } as unknown as Page }
}

it('does not focus a stale global tab during folder activation', async () => {
  const f = fixture()
  await expect(focusActiveTerminalInput(f.page)).rejects.toThrow('not focusable')
  expect(f.textarea.focus).not.toHaveBeenCalled()
  expect(f.state.setActiveTab).not.toHaveBeenCalled()
})

it('waits for selection and visible DOM without publishing another activation', async () => {
  const f = fixture()
  f.evaluate.mockImplementation(async (read, id) => {
    if (f.evaluate.mock.calls.length === 2) {
      f.state.activeTabId = 'folder-tab'
    }
    return read(id)
  })
  await focusActiveTerminalInput(f.page)
  expect(f.evaluate).toHaveBeenCalledTimes(2)
  expect(f.textarea.focus).toHaveBeenCalledTimes(1)
  expect(f.state.setActiveTab).not.toHaveBeenCalled()
  expect(f.state.setActiveTabType).not.toHaveBeenCalled()
})

it.each(['detached', 'hidden'] as const)(
  'refuses a %s terminal even with a current tab and PTY',
  async (condition) => {
    const f = fixture()
    f.state.activeTabId = 'folder-tab'
    if (condition === 'detached') {
      f.pane.container.isConnected = false
    } else {
      f.textarea.checkVisibility.mockReturnValue(false)
    }
    await expect(focusActiveTerminalInput(f.page)).rejects.toThrow('not focusable')
    expect(f.textarea.focus).not.toHaveBeenCalled()
  }
)
