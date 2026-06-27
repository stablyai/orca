// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { toast } from 'sonner'
import type { RemoveWorktreeResult } from '../../../../shared/types'
import { showPreservedBranchToast } from './preserved-branch-toast'

vi.mock('sonner', () => ({
  toast: {
    warning: vi.fn(),
    dismiss: vi.fn()
  }
}))

const mountedRoots: Root[] = []

function renderToastBody(): HTMLElement {
  const description = vi.mocked(toast.warning).mock.calls.at(-1)?.[1]
    ?.description as React.ReactElement
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  mountedRoots.push(root)
  act(() => {
    root.render(description)
  })
  return container
}

function clickButton(container: HTMLElement, label: string): void {
  const button = [...container.querySelectorAll('button')].find(
    (el) => el.textContent?.trim() === label
  )
  if (!button) {
    throw new Error(`button "${label}" not found`)
  }
  act(() => {
    button.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
}

afterEach(() => {
  mountedRoots.splice(0).forEach((root) => act(() => root.unmount()))
  document.body.innerHTML = ''
  vi.clearAllMocks()
})

describe('showPreservedBranchToast', () => {
  it('renders the branch recovery action below the long description', () => {
    const onForceDelete = vi.fn()
    const result: RemoveWorktreeResult = {
      preservedBranch: {
        branchName: 'feat/notes-send-any-running-agent',
        head: 'abc123'
      }
    }

    showPreservedBranchToast(
      result,
      {
        displayName: 'Send review notes to any running agent of a worktree',
        isMainWorktree: false
      },
      onForceDelete
    )
    const body = renderToastBody()

    expect(toast.warning).toHaveBeenCalledWith(
      'Worktree deleted, branch kept',
      expect.objectContaining({
        id: 'preserved-branch:feat/notes-send-any-running-agent:abc123',
        dismissible: true,
        duration: Infinity
      })
    )
    expect(body.textContent).toContain('feat/notes-send-any-running-agent')
    expect(body.textContent).toContain('Send review notes to any running agent of a worktree')

    clickButton(body, 'Force Delete Branch')

    expect(onForceDelete).toHaveBeenCalledWith('feat/notes-send-any-running-agent', 'abc123')
    expect(toast.dismiss).toHaveBeenCalledWith(
      'preserved-branch:feat/notes-send-any-running-agent:abc123'
    )
  })

  it('does not show the force-delete action without the preserved head', () => {
    const result: RemoveWorktreeResult = {
      preservedBranch: {
        branchName: 'feature/test'
      }
    }

    showPreservedBranchToast(result, undefined, vi.fn())
    const body = renderToastBody()

    expect(body.textContent).not.toContain('Force Delete Branch')
    expect(toast.warning).toHaveBeenCalledWith(
      'Worktree deleted, branch kept',
      expect.not.objectContaining({ duration: Infinity })
    )
  })
})
