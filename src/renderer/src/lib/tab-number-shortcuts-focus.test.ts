// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { activateTabNumberShortcut } from './tab-number-shortcuts'

const mocks = vi.hoisted(() => ({
  getState: vi.fn(),
  isWebRuntimeSessionActive: vi.fn(() => false),
  activateWebRuntimeSessionTab: vi.fn()
}))
vi.mock('@/store', () => ({ useAppStore: { getState: mocks.getState } }))
vi.mock('@/lib/worktree-runtime-owner', () => ({
  getRuntimeEnvironmentIdForWorktree: () => 'runtime-1'
}))
vi.mock('@/runtime/web-runtime-session', () => ({
  isWebRuntimeSessionActive: mocks.isWebRuntimeSessionActive,
  activateWebRuntimeSessionTab: mocks.activateWebRuntimeSessionTab
}))

function createFixture(activeLeafId: string | null = 'right') {
  const frames: FrameRequestCallback[] = []
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    frames.push(callback)
    return frames.length
  })
  vi.stubGlobal('cancelAnimationFrame', vi.fn())
  const tabs = [1, 2, 3].map((index) => ({
    id: `tab-${index}`,
    entityId: `terminal-${index}`,
    worktreeId: 'workspace',
    groupId: 'group',
    contentType: 'terminal'
  }))
  const state = {
    activeView: 'terminal',
    activeWorktreeId: 'workspace',
    activeGroupIdByWorktree: { workspace: 'group' },
    groupsByWorktree: { workspace: [{ id: 'group', tabOrder: tabs.map((tab) => tab.id) }] },
    unifiedTabsByWorktree: { workspace: tabs },
    terminalLayoutsByTabId: {
      'terminal-3': {
        activeLeafId,
        ptyIdsByLeafId: { left: 'pty-left', middle: 'pty-middle', right: 'pty-right' }
      }
    },
    focusGroup: vi.fn(),
    activateTab: vi.fn(),
    setActiveTab: vi.fn(),
    setActiveTabType: vi.fn()
  }
  mocks.getState.mockReturnValue(state)
  for (const tab of tabs) {
    const terminal = document.createElement('div')
    terminal.dataset.terminalTabId = tab.entityId
    for (const leafId of ['left', 'middle', 'right']) {
      const pane = document.createElement('div')
      pane.dataset.leafId = leafId
      const input = document.createElement('textarea')
      input.className = 'xterm-helper-textarea'
      pane.append(input)
      terminal.append(pane)
    }
    document.body.append(terminal)
  }
  const flushFrames = () => {
    while (frames.length) {
      frames.shift()?.(0)
    }
  }
  return {
    state,
    activate: (index: number) => {
      expect(activateTabNumberShortcut(index)).toBe(true)
      flushFrames()
    }
  }
}

afterEach(() => {
  document.body.replaceChildren()
  vi.unstubAllGlobals()
  vi.clearAllMocks()
  mocks.isWebRuntimeSessionActive.mockReturnValue(false)
})

describe('numbered terminal tab focus', () => {
  it.each([false, true])('restores the third connected pane (paired runtime: %s)', (paired) => {
    const { state, activate } = createFixture()
    mocks.isWebRuntimeSessionActive.mockReturnValue(paired)
    activate(0)
    activate(2)

    expect(state.activateTab).toHaveBeenLastCalledWith('tab-3')
    expect(state.setActiveTab).toHaveBeenLastCalledWith('terminal-3')
    expect(state.terminalLayoutsByTabId['terminal-3'].activeLeafId).toBe('right')
    expect(
      document.activeElement
        ?.closest('[data-terminal-tab-id]')
        ?.getAttribute('data-terminal-tab-id')
    ).toBe('terminal-3')
    expect(document.activeElement?.parentElement?.dataset.leafId).toBe('right')
    if (paired) {
      expect(mocks.activateWebRuntimeSessionTab).toHaveBeenLastCalledWith({
        worktreeId: 'workspace',
        tabId: 'terminal-3',
        environmentId: 'runtime-1'
      })
    } else {
      expect(mocks.activateWebRuntimeSessionTab).not.toHaveBeenCalled()
    }
  })

  it('retains the first-pane fallback without a saved selection', () => {
    const { activate } = createFixture(null)
    activate(2)
    expect(document.activeElement?.parentElement?.dataset.leafId).toBe('left')
  })
})
