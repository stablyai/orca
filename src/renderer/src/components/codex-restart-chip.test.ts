// @vitest-environment happy-dom

import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '../store'
import CodexRestartChip, {
  collectStalePtyIdsForTabs,
  collectStaleWorktreePtyIds,
  dismissStaleWorktreePtyIds
} from './CodexRestartChip'

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  useAppStore.setState(useAppStore.getInitialState(), true)
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => {
    root.unmount()
  })
  container.remove()
  useAppStore.setState(useAppStore.getInitialState(), true)
})

describe('CodexRestartChip helpers', () => {
  it('collects all stale PTY ids for tabs in a worktree', () => {
    expect(
      collectStaleWorktreePtyIds({
        tabsByWorktree: {
          wt1: [{ id: 'tab-1' }, { id: 'tab-2' }],
          wt2: [{ id: 'tab-3' }]
        },
        ptyIdsByTabId: {
          'tab-1': ['pty-1', 'pty-2'],
          'tab-2': ['pty-3'],
          'tab-3': ['pty-4']
        },
        codexRestartNoticeByPtyId: {
          'pty-1': { previousAccountLabel: 'a', nextAccountLabel: 'b' },
          'pty-3': { previousAccountLabel: 'a', nextAccountLabel: 'b' },
          'pty-4': { previousAccountLabel: 'a', nextAccountLabel: 'b' }
        },
        worktreeId: 'wt1'
      })
    ).toEqual(['pty-1', 'pty-3'])
  })

  it('returns an empty list when a worktree has no stale PTYs', () => {
    expect(
      collectStaleWorktreePtyIds({
        tabsByWorktree: {
          wt1: [{ id: 'tab-1' }]
        },
        ptyIdsByTabId: {
          'tab-1': ['pty-1']
        },
        codexRestartNoticeByPtyId: {},
        worktreeId: 'wt1'
      })
    ).toEqual([])
  })

  it('collects from one worktree tab slice without scanning the whole tab map', () => {
    expect(
      collectStalePtyIdsForTabs({
        tabs: [{ id: 'tab-1' }],
        ptyIdsByTabId: {
          'tab-1': ['pty-1'],
          'tab-2': ['pty-2']
        },
        codexRestartNoticeByPtyId: {
          'pty-1': { previousAccountLabel: 'a', nextAccountLabel: 'b' },
          'pty-2': { previousAccountLabel: 'a', nextAccountLabel: 'b' }
        }
      })
    ).toEqual(['pty-1'])
  })

  it('drops PTYs whose restart is already requested', () => {
    expect(
      collectStalePtyIdsForTabs({
        tabs: [{ id: 'tab-1' }],
        ptyIdsByTabId: {
          'tab-1': ['pty-1', 'pty-2']
        },
        codexRestartNoticeByPtyId: {
          'pty-1': { previousAccountLabel: 'a', nextAccountLabel: 'b', restartRequested: true },
          'pty-2': { previousAccountLabel: 'a', nextAccountLabel: 'b' }
        }
      })
    ).toEqual(['pty-2'])
  })

  it('dismisses every stale PTY notice in the worktree prompt', () => {
    const dismissCodexRestartNotices = vi.fn()
    const forgetLaunchAccounts = vi.fn()

    dismissStaleWorktreePtyIds(['pty-1', 'pty-3'], dismissCodexRestartNotices, forgetLaunchAccounts)

    expect(dismissCodexRestartNotices).toHaveBeenCalledWith(['pty-1', 'pty-3'])
    expect(forgetLaunchAccounts).toHaveBeenCalledWith(['pty-1', 'pty-3'])
  })

  it('drops dismissed PTYs from the prompt while keeping their launch account', () => {
    expect(
      collectStalePtyIdsForTabs({
        tabs: [{ id: 'tab-1' }],
        ptyIdsByTabId: {
          'tab-1': ['pty-1', 'pty-2']
        },
        codexRestartNoticeByPtyId: {
          'pty-1': { previousAccountLabel: 'a', nextAccountLabel: 'b', dismissed: true },
          'pty-2': { previousAccountLabel: 'a', nextAccountLabel: 'b' }
        }
      })
    ).toEqual(['pty-2'])
  })

  it('renders only account-resolution actions without an external-store update loop', async () => {
    useAppStore.setState({
      tabsByWorktree: {
        'worktree-1': [
          {
            id: 'tab-1',
            worktreeId: 'worktree-1',
            title: 'Terminal',
            customTitle: null,
            color: null,
            sortOrder: 0,
            createdAt: 1,
            ptyId: null
          }
        ]
      },
      ptyIdsByTabId: {
        'tab-1': ['pty-1']
      },
      codexRestartNoticeByPtyId: {
        'pty-1': {
          previousAccountLabel: 'old@example.com',
          nextAccountLabel: 'new@example.com'
        }
      }
    })

    await act(async () => {
      root.render(React.createElement(CodexRestartChip, { worktreeId: 'worktree-1' }))
    })

    expect(container.textContent).toContain('Codex is still signed in as old@example.com')
    expect(
      Array.from(container.querySelectorAll('button'), (button) => button.textContent?.trim())
    ).toEqual(['Keep old account', 'Restart'])
  })

  it('uses configuration wording for a home-route restart', async () => {
    useAppStore.setState({
      tabsByWorktree: {
        'worktree-1': [
          {
            id: 'tab-1',
            worktreeId: 'worktree-1',
            title: 'Terminal',
            customTitle: null,
            color: null,
            sortOrder: 0,
            createdAt: 1,
            ptyId: null
          }
        ]
      },
      ptyIdsByTabId: { 'tab-1': ['pty-1'] },
      codexRestartNoticeByPtyId: {
        'pty-1': {
          previousAccountLabel: 'System default',
          nextAccountLabel: 'System default',
          previousAccountId: null,
          nextAccountId: null,
          homeRouteChanged: true
        }
      }
    })

    await act(async () => {
      root.render(React.createElement(CodexRestartChip, { worktreeId: 'worktree-1' }))
    })

    expect(container.textContent).toContain('Codex setup changed')
    expect(container.textContent).toContain('This Codex session is using an outdated configuration')
    expect(container.textContent).toContain(
      'Restart this session to load your current Codex configuration.'
    )
    expect(
      Array.from(container.querySelectorAll('button'), (button) => button.textContent?.trim())
    ).toEqual(['Keep current session', 'Restart'])
  })

  it('forgets the launch record when the user keeps the old account', async () => {
    const forgetStalePanes = vi.fn(() => Promise.resolve())
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { codexAccounts: { forgetStalePanes } }
    })
    useAppStore.setState({
      tabsByWorktree: {
        'worktree-1': [
          {
            id: 'tab-1',
            worktreeId: 'worktree-1',
            title: 'Terminal',
            customTitle: null,
            color: null,
            sortOrder: 0,
            createdAt: 1,
            ptyId: null
          }
        ]
      },
      ptyIdsByTabId: { 'tab-1': ['pty-1'] },
      codexRestartNoticeByPtyId: {
        'pty-1': {
          previousAccountLabel: 'old@example.com',
          nextAccountLabel: 'new@example.com'
        }
      }
    })
    await act(async () => {
      root.render(React.createElement(CodexRestartChip, { worktreeId: 'worktree-1' }))
    })

    const dismissButton = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent?.trim() === 'Keep old account'
    )
    await act(async () => {
      dismissButton?.click()
    })

    // Why: without this the startup sweep re-raises the prompt the user just answered.
    expect(forgetStalePanes).toHaveBeenCalledWith({ ptyIds: ['pty-1'] })
    expect(container.textContent).toBe('')
    // Why: the record survives as the pane's launch-account memory, but marked
    // answered so it neither prompts again nor blocks the pane's keyboard.
    expect(useAppStore.getState().codexRestartNoticeByPtyId['pty-1']).toEqual({
      previousAccountLabel: 'old@example.com',
      nextAccountLabel: 'new@example.com',
      dismissed: true
    })
  })

  it('stays closed when the user re-selects the account the pane launched under', async () => {
    const forgetStalePanes = vi.fn(() => Promise.resolve())
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { codexAccounts: { forgetStalePanes } }
    })
    useAppStore.setState({
      tabsByWorktree: {
        'worktree-1': [
          {
            id: 'tab-1',
            worktreeId: 'worktree-1',
            title: 'Terminal',
            customTitle: null,
            color: null,
            sortOrder: 0,
            createdAt: 1,
            ptyId: null
          }
        ]
      },
      ptyIdsByTabId: { 'tab-1': ['pty-1'] }
    })
    useAppStore.getState().markCodexRestartNotices([
      {
        ptyId: 'pty-1',
        previousAccountLabel: 'old@example.com',
        nextAccountLabel: 'new@example.com'
      }
    ])
    await act(async () => {
      root.render(React.createElement(CodexRestartChip, { worktreeId: 'worktree-1' }))
    })
    const dismissButton = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent?.trim() === 'Keep old account'
    )
    await act(async () => {
      dismissButton?.click()
    })

    // Re-select the pane's original account: it never left it, so there is
    // nothing to restart and nothing to prompt about.
    await act(async () => {
      useAppStore.getState().markCodexRestartNotices([
        {
          ptyId: 'pty-1',
          previousAccountLabel: 'new@example.com',
          nextAccountLabel: 'old@example.com'
        }
      ])
    })

    expect(container.textContent).toBe('')
    expect(useAppStore.getState().codexRestartNoticeByPtyId['pty-1']).toBeUndefined()
  })

  it('reopens the prompt when a dismissed pane is out of date against a third account', async () => {
    const forgetStalePanes = vi.fn(() => Promise.resolve())
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { codexAccounts: { forgetStalePanes } }
    })
    useAppStore.setState({
      tabsByWorktree: {
        'worktree-1': [
          {
            id: 'tab-1',
            worktreeId: 'worktree-1',
            title: 'Terminal',
            customTitle: null,
            color: null,
            sortOrder: 0,
            createdAt: 1,
            ptyId: null
          }
        ]
      },
      ptyIdsByTabId: { 'tab-1': ['pty-1'] }
    })
    useAppStore.getState().markCodexRestartNotices([
      {
        ptyId: 'pty-1',
        previousAccountLabel: 'old@example.com',
        nextAccountLabel: 'new@example.com'
      }
    ])
    await act(async () => {
      root.render(React.createElement(CodexRestartChip, { worktreeId: 'worktree-1' }))
    })
    const dismissButton = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent?.trim() === 'Keep old account'
    )
    await act(async () => {
      dismissButton?.click()
    })
    expect(container.textContent).toBe('')

    await act(async () => {
      useAppStore.getState().markCodexRestartNotices([
        {
          ptyId: 'pty-1',
          previousAccountLabel: 'new@example.com',
          nextAccountLabel: 'third@example.com'
        }
      ])
    })

    // Why: the dismissal answered "keep old instead of new", not "never prompt
    // again"; the pane really is out of date against third@example.com.
    expect(container.textContent).toContain('Codex is still signed in as old@example.com')
    expect(container.textContent).toContain('Restart this session to use third@example.com')
  })

  it('closes the prompt after Restart even when no mounted pane can run it yet', async () => {
    useAppStore.setState({
      tabsByWorktree: {
        'worktree-1': [
          {
            id: 'tab-1',
            worktreeId: 'worktree-1',
            title: 'Terminal',
            customTitle: null,
            color: null,
            sortOrder: 0,
            createdAt: 1,
            ptyId: null
          }
        ]
      },
      ptyIdsByTabId: { 'tab-1': ['pty-1'] },
      codexRestartNoticeByPtyId: {
        'pty-1': {
          previousAccountLabel: 'old@example.com',
          nextAccountLabel: 'new@example.com'
        }
      }
    })
    await act(async () => {
      root.render(React.createElement(CodexRestartChip, { worktreeId: 'worktree-1' }))
    })

    const restartButton = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent?.trim() === 'Restart'
    )
    await act(async () => {
      restartButton?.click()
    })

    expect(container.textContent).toBe('')
    // Why: the pane still has to restart; only the prompt is answered.
    expect(useAppStore.getState().pendingCodexPaneRestartIds).toEqual({ 'pty-1': true })
    expect(useAppStore.getState().codexRestartNoticeByPtyId['pty-1']?.restartRequested).toBe(true)
  })
})

describe('CodexRestartChip focus target', () => {
  function renderWithFocusedSiblingPane(): HTMLTextAreaElement {
    // Mirrors Terminal.tsx, which mounts the chip as a SIBLING of the split
    // layout — so the chip's parentElement is the whole worktree surface and
    // its focus scope covers every pane in it, not just the stale one.
    const splitLayout = document.createElement('div')
    const healthyPaneInput = document.createElement('textarea')
    healthyPaneInput.className = 'xterm-helper-textarea'
    splitLayout.appendChild(healthyPaneInput)
    container.appendChild(splitLayout)
    healthyPaneInput.focus()

    useAppStore.setState({
      tabsByWorktree: {
        'worktree-1': [
          {
            id: 'tab-1',
            worktreeId: 'worktree-1',
            title: 'Terminal',
            customTitle: null,
            color: null,
            sortOrder: 0,
            createdAt: 1,
            ptyId: null
          }
        ]
      },
      ptyIdsByTabId: { 'tab-1': ['pty-1'] }
    })
    useAppStore.getState().markCodexRestartNotices([
      {
        ptyId: 'pty-1',
        previousAccountLabel: 'old@example.com',
        nextAccountLabel: 'new@example.com'
      }
    ])
    return healthyPaneInput
  }

  it('never parks focus on Restart, so a stray keystroke cannot kill the session', async () => {
    renderWithFocusedSiblingPane()

    await act(async () => {
      root.render(React.createElement(CodexRestartChip, { worktreeId: 'worktree-1' }))
    })

    // Regression (#10863): focus used to land on Restart. The card is worktree
    // scoped, so it fires while the user is typing in a DIFFERENT, healthy pane
    // — and the next Space/Enter of their prose restarted every stale pane here.
    const restartButton = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent?.trim() === 'Restart'
    )
    expect(restartButton).toBeDefined()
    expect(document.activeElement).not.toBe(restartButton)
    expect((document.activeElement as HTMLElement | null)?.getAttribute('role')).toBe('dialog')

    // The keystroke that used to destroy the session now does nothing.
    await act(async () => {
      ;(document.activeElement as HTMLElement | null)?.click()
    })
    expect(useAppStore.getState().pendingCodexPaneRestartIds).toEqual({})
  })

  it('still moves focus off the terminal so the card is reachable by keyboard', async () => {
    const healthyPaneInput = renderWithFocusedSiblingPane()

    await act(async () => {
      root.render(React.createElement(CodexRestartChip, { worktreeId: 'worktree-1' }))
    })

    // Why: the fix must not turn into "never take focus" — assistive tech and
    // keyboard users still need to land on the dialog and Tab to its actions.
    expect(document.activeElement).not.toBe(healthyPaneInput)
    expect(document.activeElement).toBe(container.querySelector('[role="dialog"]'))
  })
})
