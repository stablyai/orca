// @vitest-environment happy-dom

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { ConfirmationDialogProvider } from '@/components/dismiss/confirmation/confirmation-dialog'
import { TooltipProvider } from '@/components/ui/tooltip'
import { useAppStore } from '@/store'
import { TEST_REPO } from '@/store/repos/repo.test-fixture'
import { makeWorktree } from '@/store/slices/worktrees/worktree.test-fixture'
import WorktreeContextMenu from './WorktreeContextMenu'

const initialStoreState = useAppStore.getInitialState()
const repo = { ...TEST_REPO, id: 'repo-1' }
const worktree = makeWorktree({
  id: 'repo-1::/workspace-a',
  repoId: repo.id,
  displayName: 'Workspace A'
})

afterEach(() => {
  cleanup()
  useAppStore.setState(initialStoreState, true)
})

function renderHarness() {
  useAppStore.setState({
    repos: [repo],
    worktreesByRepo: { [repo.id]: [worktree] }
  })

  render(
    <TooltipProvider>
      <ConfirmationDialogProvider>
        <div data-worktree-sidebar tabIndex={-1}>
          <WorktreeContextMenu worktree={worktree}>
            <div data-testid="card">Workspace A</div>
          </WorktreeContextMenu>
        </div>
        <div data-testid="outside-chrome">Outside area</div>
        <textarea aria-label="Terminal input" />
      </ConfirmationDialogProvider>
    </TooltipProvider>
  )

  const sidebar = document.querySelector<HTMLElement>('[data-worktree-sidebar]')!
  const card = screen.getByTestId('card')
  const outsideChrome = screen.getByTestId('outside-chrome')
  const terminalInput = screen.getByLabelText<HTMLTextAreaElement>('Terminal input')
  return { sidebar, card, outsideChrome, terminalInput }
}

// Radix FocusScope dispatches onCloseAutoFocus in a setTimeout(0) after unmount.
async function flushCloseAutoFocus() {
  await act(async () => {
    await new Promise((resolve) => window.setTimeout(resolve, 0))
  })
}

async function openContextMenu(card: HTMLElement) {
  await act(async () => {
    fireEvent.contextMenu(card, { clientX: 20, clientY: 20 })
  })
  expect(screen.getByRole('menu')).toBeTruthy()
}

describe('WorktreeContextMenu focus on close', () => {
  it('keeps terminal focus when dismissed by clicking the terminal', async () => {
    const { sidebar, card, terminalInput } = renderHarness()
    terminalInput.focus()
    expect(document.activeElement).toBe(terminalInput)

    await openContextMenu(card)
    expect(document.activeElement).not.toBe(terminalInput)

    await act(async () => {
      fireEvent.pointerDown(terminalInput, { button: 0, pointerType: 'mouse' })
      terminalInput.focus()
    })
    await flushCloseAutoFocus()

    expect(screen.queryByRole('menu')).toBeNull()
    expect(document.activeElement).toBe(terminalInput)
    expect(document.activeElement).not.toBe(sidebar)
  })

  it('does not pull focus back to the sidebar when dismissed by clicking non-focusable outside chrome', async () => {
    const { sidebar, card, outsideChrome } = renderHarness()

    await openContextMenu(card)

    await act(async () => {
      fireEvent.pointerDown(outsideChrome, { button: 0, pointerType: 'mouse' })
    })
    await flushCloseAutoFocus()

    expect(screen.queryByRole('menu')).toBeNull()
    expect(document.activeElement).not.toBe(sidebar)
  })

  it('returns focus to the sidebar on Escape, including after a prior outside dismissal', async () => {
    const { sidebar, card, terminalInput } = renderHarness()

    await openContextMenu(card)
    await act(async () => {
      fireEvent.pointerDown(terminalInput, { button: 0, pointerType: 'mouse' })
      terminalInput.focus()
    })
    await flushCloseAutoFocus()
    expect(screen.queryByRole('menu')).toBeNull()
    expect(document.activeElement).toBe(terminalInput)

    await openContextMenu(card)
    await act(async () => {
      fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' })
    })
    await flushCloseAutoFocus()

    expect(screen.queryByRole('menu')).toBeNull()
    expect(document.activeElement).toBe(sidebar)
  })

  it('does not steal focus when another control claims focus before the menu finishes closing', async () => {
    const { sidebar, card, terminalInput } = renderHarness()

    await openContextMenu(card)
    await act(async () => {
      fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' })
      terminalInput.focus()
    })
    await flushCloseAutoFocus()

    expect(screen.queryByRole('menu')).toBeNull()
    expect(document.activeElement).toBe(terminalInput)
    expect(document.activeElement).not.toBe(sidebar)
  })
})
