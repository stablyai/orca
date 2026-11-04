// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { toast } from 'sonner'
import { showDeleteWorktreeFailureToast } from './delete-worktree-failure-toast'

vi.mock('sonner', () => ({
  toast: {
    error: vi.fn(),
    info: vi.fn(),
    dismiss: vi.fn()
  }
}))

const mountedRoots: Root[] = []

function renderToastBody(method: 'error' | 'info'): HTMLElement {
  const description = vi.mocked(toast[method]).mock.calls.at(-1)?.[1]
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

describe('showDeleteWorktreeFailureToast', () => {
  it('uses a persistent in-body action footer when force delete is available', () => {
    const onViewChanges = vi.fn()
    const onForceDelete = vi.fn()
    const onDeleteAnyway = vi.fn()

    showDeleteWorktreeFailureToast({
      error: 'branch has changes',
      canForceDelete: true,
      forceDeleteReason: 'dirty',
      onViewChanges,
      onForceDelete,
      onDeleteAnyway,
      worktreeId: 'wt-1',
      worktreeName: 'feature/foo'
    })

    expect(toast.info).toHaveBeenCalledWith(
      'Failed to delete workspace feature/foo',
      expect.objectContaining({
        id: 'delete-worktree-failure:|wt-1',
        dismissible: true,
        duration: Infinity
      })
    )
    const options = vi.mocked(toast.info).mock.calls.at(-1)?.[1] as
      | { action?: unknown; cancel?: unknown }
      | undefined
    expect(options?.action).toBeUndefined()
    expect(options?.cancel).toBeUndefined()

    const body = renderToastBody('info')
    expect(body.textContent).toContain('It has changed files.')

    clickButton(body, 'View')
    expect(toast.dismiss).toHaveBeenCalledWith('delete-worktree-failure:|wt-1')
    expect(onViewChanges).toHaveBeenCalled()

    clickButton(body, 'Force Delete')
    expect(toast.dismiss).toHaveBeenCalledWith('delete-worktree-failure:|wt-1')
    expect(onForceDelete).toHaveBeenCalled()
  })

  it('offers Delete Anyway when the archive hook refused the removal', () => {
    const onDeleteAnyway = vi.fn()

    showDeleteWorktreeFailureToast({
      error: 'Archive hook failed for worktree: /w/feature — exited 23.',
      canForceDelete: false,
      forceDeleteReason: null,
      canWaiveArchiveHook: true,
      onViewChanges: vi.fn(),
      onForceDelete: vi.fn(),
      onDeleteAnyway,
      worktreeId: 'wt-archive',
      worktreeName: 'feature/archive'
    })

    expect(toast.error).toHaveBeenCalledWith(
      'Failed to delete workspace feature/archive',
      expect.objectContaining({ duration: Infinity })
    )

    const body = renderToastBody('error')
    expect(body.textContent).toContain('Delete Anyway')
    expect(body.textContent).not.toContain('Force Delete')

    clickButton(body, 'Delete Anyway')
    expect(toast.dismiss).toHaveBeenCalledWith('delete-worktree-failure:|wt-archive')
    expect(onDeleteAnyway).toHaveBeenCalled()
  })
})
