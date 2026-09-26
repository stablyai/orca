// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

type FakeState = {
  activeWorktreeId: string | null
  activeTabType: string
  activeTabId: string | null
  tabsByWorktree: Record<string, { id: string }[]>
  terminalLayoutsByTabId: Record<string, { activeLeafId: string | null }>
}

const mocks = vi.hoisted(() => {
  const holder: { state: FakeState | undefined } = { state: undefined }
  return { holder, focusTerminalTabSurface: vi.fn() }
})

vi.mock('@/lib/focus-terminal-tab-surface', () => ({
  focusTerminalTabSurface: mocks.focusTerminalTabSurface
}))
vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => {
      if (!mocks.holder.state) {
        throw new Error('test state not set')
      }
      return mocks.holder.state
    }
  }
}))

const { focusActiveWorkspaceTerminal } = await import('./focus-active-workspace-terminal')

const LEAF = '11111111-1111-4111-8111-111111111111'

function setState(overrides: Partial<FakeState> = {}): void {
  mocks.holder.state = {
    activeWorktreeId: 'wt-b',
    activeTabType: 'terminal',
    activeTabId: 'tab-b',
    tabsByWorktree: { 'wt-a': [{ id: 'tab-a' }], 'wt-b': [{ id: 'tab-b' }] },
    terminalLayoutsByTabId: { 'tab-b': { activeLeafId: LEAF } },
    ...overrides
  }
}

function terminalInput(): HTMLTextAreaElement {
  const input = document.createElement('textarea')
  input.className = 'xterm-helper-textarea'
  document.body.append(input)
  return input
}

beforeEach(() => {
  mocks.focusTerminalTabSurface.mockClear()
})

afterEach(() => {
  document.body.innerHTML = ''
})

describe('Enter in the workspace list', () => {
  it("focuses the active workspace's terminal pane, not the first terminal in the page", () => {
    setState()
    const otherWorkspaceInput = terminalInput()

    focusActiveWorkspaceTerminal()

    expect(mocks.focusTerminalTabSurface).toHaveBeenCalledWith('tab-b', LEAF)
    expect(document.activeElement).not.toBe(otherWorkspaceInput)
  })

  it('focuses the tab without a pane when the active leaf is unknown', () => {
    setState({ terminalLayoutsByTabId: {} })

    focusActiveWorkspaceTerminal()

    expect(mocks.focusTerminalTabSurface).toHaveBeenCalledWith('tab-b', null)
  })

  it.each([
    ['the active tab is not a terminal', { activeTabType: 'editor' }],
    ['the active tab belongs to another workspace', { activeTabId: 'tab-a' }]
  ])('keeps the previous behaviour when %s', (_label, overrides) => {
    setState(overrides)
    const input = terminalInput()

    focusActiveWorkspaceTerminal()

    expect(mocks.focusTerminalTabSurface).not.toHaveBeenCalled()
    expect(document.activeElement).toBe(input)
  })
})
