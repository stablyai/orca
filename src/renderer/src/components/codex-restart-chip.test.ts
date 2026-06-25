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

  it('dismisses every stale PTY notice in the worktree prompt', () => {
    const clearCodexRestartNotice = vi.fn()

    dismissStaleWorktreePtyIds(['pty-1', 'pty-3'], clearCodexRestartNotice)

    expect(clearCodexRestartNotice).toHaveBeenNthCalledWith(1, 'pty-1')
    expect(clearCodexRestartNotice).toHaveBeenNthCalledWith(2, 'pty-3')
    expect(clearCodexRestartNotice).toHaveBeenCalledTimes(2)
  })

  it('renders a stale Codex restart notice without an external-store update loop', async () => {
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
  })
})
