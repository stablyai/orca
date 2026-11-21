// @vitest-environment happy-dom

import { act, cleanup, render, screen } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { useAppStore } from '@/store/index'
import type { BrowserWorkspace } from '../../../../../../shared/browser/workspaces/browser-workspace-types'
import CloseTerminalDialog from './CloseTerminalDialog'

const initialState = useAppStore.getInitialState()

function mountActiveLeaf(): HTMLTextAreaElement {
  const tab = document.createElement('div')
  tab.setAttribute('data-terminal-tab-id', 'tab-1')
  const leaf = document.createElement('div')
  leaf.setAttribute('data-leaf-id', 'leaf-1')
  const helper = document.createElement('textarea')
  helper.className = 'xterm-helper-textarea'
  leaf.append(helper)
  tab.append(leaf)
  document.body.append(tab)
  return helper
}

function flushFocusFrames(): Promise<void> {
  return act(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
      })
  )
}

function OpenCloseDialog({ queued = 0 }: { queued?: number }): React.JSX.Element {
  const [open, setOpen] = useState(true)
  const [remaining, setRemaining] = useState(queued)
  // Mirrors the running-close queue: Stop on a queued subject keeps the dialog open for the next one.
  const advance = (): void => {
    if (remaining > 0) {
      setRemaining(remaining - 1)
    } else {
      setOpen(false)
    }
  }
  return (
    <CloseTerminalDialog
      open={open}
      subjectKey={`tab-${remaining}`}
      onSleepInstead={() => setOpen(false)}
      onCancel={() => setOpen(false)}
      onConfirm={advance}
    />
  )
}

function focusOpener(): HTMLTextAreaElement {
  const opener = document.createElement('textarea')
  document.body.append(opener)
  opener.focus()
  return opener
}

async function clickButton(name: string): Promise<void> {
  await act(async () => {
    screen.getByRole('button', { name }).click()
  })
}

beforeEach(() => {
  useAppStore.setState(initialState, true)
  useAppStore.setState({
    activeWorktreeId: 'wt-1',
    activeTabType: 'terminal',
    activeTabId: 'tab-1',
    activeTabIdByWorktree: { 'wt-1': 'tab-1' },
    terminalLayoutsByTabId: {
      'tab-1': {
        root: { type: 'leaf', leafId: 'leaf-1' },
        activeLeafId: 'leaf-1',
        expandedLeafId: null
      }
    }
  })
  document.body.replaceChildren()
})

afterEach(() => {
  cleanup()
  document.body.replaceChildren()
  useAppStore.setState(initialState, true)
})

it('returns focus to the active terminal pane when the close dialog is cancelled', async () => {
  const helper = mountActiveLeaf()
  render(<OpenCloseDialog />)
  await clickButton('Cancel')
  await flushFocusFrames()
  expect(document.activeElement).toBe(helper)
})

it('restores focus when a queued prompt is cancelled after stopping the previous one', async () => {
  mountActiveLeaf()
  const opener = focusOpener()
  render(<OpenCloseDialog queued={1} />)
  await clickButton('Stop and close')
  await clickButton('Cancel')
  await flushFocusFrames()
  expect(document.activeElement).toBe(opener)
})

// A floating terminal can raise the prompt while the main workspace shows a browser tab.
it('returns to the opener over a main-workspace browser tab', async () => {
  const browserWorkspace: BrowserWorkspace = {
    id: 'browser-1',
    worktreeId: 'wt-1',
    title: 'Docs',
    url: 'https://example.com/',
    activePageId: 'page-1',
    loading: false,
    canGoBack: false,
    canGoForward: false,
    faviconUrl: null,
    loadError: null,
    createdAt: 1
  }
  useAppStore.setState({
    activeTabType: 'browser',
    activeBrowserTabId: 'browser-1',
    browserTabsByWorktree: { 'wt-1': [browserWorkspace] }
  })
  const opener = focusOpener()
  render(<OpenCloseDialog />)
  await clickButton('Cancel')
  await flushFocusFrames()
  expect(document.activeElement).toBe(opener)
})

it('does not move focus into another group terminal when an agent-session prompt had no opener', async () => {
  useAppStore.setState({ activeTabType: 'agent-session' })
  const helper = mountActiveLeaf()
  render(<OpenCloseDialog />)
  await clickButton('Cancel')
  await flushFocusFrames()
  expect(document.activeElement).not.toBe(helper)
})
