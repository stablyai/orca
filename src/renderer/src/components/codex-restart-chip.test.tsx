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
const PTY_TWO = 'worktree-1@@pty-2'

let container: HTMLDivElement
let forgetStalePanes: ReturnType<typeof vi.fn>
let root: Root

function notice(previousAccountLabel: string, nextAccountLabel: string) {
  return { previousAccountLabel, nextAccountLabel }
}

function button(scope: ParentNode, label: string): HTMLButtonElement {
  const match = Array.from(scope.querySelectorAll('button')).find(
    (candidate) => candidate.textContent?.trim() === label
  )
  if (!match) {
    throw new Error(`missing ${label} button`)
  }
  return match
}

beforeEach(() => {
  returnFocus.mockReset()
  useAppStore.setState(useAppStore.getInitialState(), true)
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

describe('CodexRestartChip pane ownership', () => {
  it('follows a pane replacement id without acting on the retired PTY', async () => {
    useAppStore.setState({
      codexRestartNoticeByPtyId: {
        [PTY_ONE]: notice('retired@example.com', 'target@example.com')
      }
    })
    await act(async () => {
      root.render(<CodexRestartChip ptyId={PTY_ONE} />)
    })

    await act(async () => {
      useAppStore.setState({
        codexRestartNoticeByPtyId: {
          [PTY_TWO]: notice('replacement@example.com', 'target@example.com')
        }
      })
      root.render(<CodexRestartChip ptyId={PTY_TWO} />)
    })
    await act(async () => {
      button(container, 'Restart').click()
    })

    expect(useAppStore.getState().pendingPaneAccountRestarts).toEqual({ [PTY_TWO]: 'codex' })
    expect(useAppStore.getState().pendingPaneAccountRestarts[PTY_ONE]).toBeUndefined()
  })
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
