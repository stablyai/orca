// @vitest-environment happy-dom

import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '../store'
import CodexRestartChipComponent from './CodexRestartChip'

const returnFocus = vi.fn()
function CodexRestartChip(
  props: Omit<React.ComponentProps<typeof CodexRestartChipComponent>, 'onReturnFocus'>
) {
  return <CodexRestartChipComponent {...props} onReturnFocus={returnFocus} />
}

globalThis.IS_REACT_ACT_ENVIRONMENT = true

const PTY_ONE = 'worktree-1@@pty-1'

let container: HTMLDivElement
let forgetStalePanes: ReturnType<typeof vi.fn>
let root: Root

beforeEach(() => {
  returnFocus.mockReset()
  useAppStore.setState(useAppStore.getInitialState(), true)
  useAppStore.setState({
    tabsByWorktree: {
      wt: [
        {
          id: 'tab',
          worktreeId: 'wt',
          createdAt: 1,
          ptyId: PTY_ONE,
          title: '',
          customTitle: null,
          color: null,
          sortOrder: 0
        }
      ]
    },
    terminalLayoutsByTabId: {
      tab: {
        root: { type: 'leaf', leafId: '00000000-0000-4000-8000-000000000001' },
        activeLeafId: '00000000-0000-4000-8000-000000000001',
        expandedLeafId: null,
        ptyIdsByLeafId: { '00000000-0000-4000-8000-000000000001': PTY_ONE }
      }
    },
    ptyIdsByTabId: { tab: [PTY_ONE] }
  })
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  forgetStalePanes = vi.fn(() => Promise.resolve())
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: { codexAccounts: { forgetStalePanes } }
  })
})

afterEach(() => {
  act(() => {
    root.unmount()
  })
  container.remove()
  useAppStore.setState(useAppStore.getInitialState(), true)
})

describe('CodexRestartChip pane focus', () => {
  async function renderPane(shouldFocus: boolean, isVisible = true): Promise<HTMLTextAreaElement> {
    await act(async () => {
      root.render(
        <div data-pane="stale">
          <textarea className="xterm-helper-textarea" />
          <CodexRestartChip isVisible={isVisible} ptyId={PTY_ONE} shouldFocus={shouldFocus} />
        </div>
      )
    })
    const terminalInput = container.querySelector('textarea')!
    terminalInput.focus()
    await act(async () => {
      useAppStore.getState().markCodexRestartNotices([
        {
          ptyId: PTY_ONE,
          previousAccountLabel: 'old@example.com',
          nextAccountLabel: 'new@example.com'
        }
      ])
    })
    return terminalInput
  }

  it('does not dismiss when a card text selection ends on the backdrop', async () => {
    await renderPane(true)
    const dialog = container.querySelector('[role="dialog"]')!
    await act(async () => {
      dialog.querySelector('div')!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
      dialog.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
      dialog.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(container.querySelector('[role="dialog"]')).not.toBeNull()
    expect(returnFocus).not.toHaveBeenCalled()
    expect(forgetStalePanes).not.toHaveBeenCalled()
  })
})
