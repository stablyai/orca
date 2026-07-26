// @vitest-environment happy-dom

import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import WorktreeMetaDialog from './WorktreeMetaDialog'

const { closeModal, updateWorktreeMeta } = vi.hoisted(() => ({
  closeModal: vi.fn(),
  updateWorktreeMeta: vi.fn(async () => undefined)
}))

vi.mock('@/store', () => ({
  useAppStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({
      activeModal: 'edit-meta',
      modalData: { worktreeId: 'repo::/repo', currentDisplayName: '', focus: 'comment' },
      closeModal,
      updateWorktreeMeta,
      fetchIssue: vi.fn(),
      worktreesByRepo: {}
    })
}))

vi.mock('@/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: React.ReactNode }) => <span>{children}</span>
}))

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  updateWorktreeMeta.mockClear()
  closeModal.mockClear()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => {
    root.unmount()
  })
  document.body.innerHTML = ''
})

function renderDialog(): { displayNameInput: HTMLInputElement; comment: HTMLTextAreaElement } {
  act(() => {
    root.render(<WorktreeMetaDialog />)
  })
  const displayNameInput = document.body.querySelector('input')
  const comment = document.body.querySelector('textarea')
  if (!displayNameInput || !comment) {
    throw new Error('worktree meta fields not rendered')
  }
  return { displayNameInput, comment }
}

function pressEnter(element: HTMLElement, init?: KeyboardEventInit & { keyCode?: number }): void {
  const event = new KeyboardEvent('keydown', {
    key: 'Enter',
    bubbles: true,
    cancelable: true,
    ...init
  })
  if (init?.keyCode !== undefined) {
    Object.defineProperty(event, 'keyCode', { value: init.keyCode })
  }
  act(() => {
    element.dispatchEvent(event)
  })
}

describe('WorktreeMetaDialog IME Enter guard', () => {
  it('does not save the note on the Enter that commits an IME composition', () => {
    const { comment } = renderDialog()

    pressEnter(comment, { isComposing: true })

    expect(updateWorktreeMeta).not.toHaveBeenCalled()
  })

  it('does not save it for IMEs that report keyCode 229 without isComposing', () => {
    const { comment } = renderDialog()

    pressEnter(comment, { keyCode: 229 })

    expect(updateWorktreeMeta).not.toHaveBeenCalled()
  })

  it('does not save the display name on an IME-composition Enter', () => {
    const { displayNameInput } = renderDialog()

    pressEnter(displayNameInput, { isComposing: true })

    expect(updateWorktreeMeta).not.toHaveBeenCalled()
  })

  it('still saves on a plain Enter', () => {
    const { comment } = renderDialog()

    pressEnter(comment)

    expect(updateWorktreeMeta).toHaveBeenCalledTimes(1)
  })
})
