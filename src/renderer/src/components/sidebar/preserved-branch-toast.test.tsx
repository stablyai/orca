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
  it('renders the branch recovery action below the long description', async () => {
    const onForceDelete = vi.fn().mockResolvedValue(true)
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
      onForceDelete,
      vi.fn(),
      'cleanup-one'
    )
    const body = renderToastBody()

    expect(toast.warning).toHaveBeenCalledWith(
      'Worktree deleted, branch kept',
      expect.objectContaining({
        id: 'preserved-branch:cleanup-one',
        dismissible: true,
        duration: Infinity
      })
    )
    expect(body.textContent).toContain('feat/notes-send-any-running-agent')
    expect(body.textContent).toContain('Send review notes to any running agent of a worktree')

    clickButton(body, 'Force Delete Branch')

    expect(onForceDelete).toHaveBeenCalledWith('feat/notes-send-any-running-agent', 'abc123')
    await vi.waitFor(() =>
      expect(toast.dismiss).toHaveBeenCalledWith('preserved-branch:cleanup-one')
    )
  })

  it('does not show the force-delete action without the preserved head', () => {
    const result: RemoveWorktreeResult = {
      preservedBranch: {
        branchName: 'feature/test'
      }
    }

    showPreservedBranchToast(result, undefined, vi.fn().mockResolvedValue(true))
    const body = renderToastBody()

    expect(body.textContent).not.toContain('Force Delete Branch')
    expect(toast.warning).toHaveBeenCalledWith(
      'Worktree deleted, branch kept',
      expect.not.objectContaining({ duration: Infinity })
    )
  })

  it.each(['onDismiss', 'onAutoClose'] as const)(
    '%s releases the retained cleanup route',
    (event) => {
      const onRelease = vi.fn()
      showPreservedBranchToast(
        { preservedBranch: { branchName: 'feature/test', head: 'abc123' } },
        undefined,
        vi.fn().mockResolvedValue(true),
        onRelease,
        'cleanup-release'
      )

      const options = vi.mocked(toast.warning).mock.calls.at(-1)?.[1]
      options?.[event]?.({ id: 'preserved-branch:cleanup-release' } as never)
      options?.onDismiss?.({ id: 'preserved-branch:cleanup-release' } as never)
      options?.onAutoClose?.({ id: 'preserved-branch:cleanup-release' } as never)

      expect(onRelease).toHaveBeenCalledOnce()
    }
  )

  it('releases a pending force-delete route when the toast is dismissed', () => {
    const onRelease = vi.fn()
    showPreservedBranchToast(
      { preservedBranch: { branchName: 'feature/test', head: 'abc123' } },
      undefined,
      vi.fn().mockResolvedValue(true),
      onRelease,
      'cleanup-delete'
    )
    const body = renderToastBody()
    const options = vi.mocked(toast.warning).mock.calls.at(-1)?.[1]

    clickButton(body, 'Force Delete Branch')
    options?.onDismiss?.({ id: 'preserved-branch:cleanup-delete' } as never)

    expect(onRelease).toHaveBeenCalledOnce()
  })

  it('keeps the force-delete surface when deletion fails', async () => {
    const onRelease = vi.fn()
    const onForceDelete = vi.fn().mockResolvedValue(false)
    showPreservedBranchToast(
      { preservedBranch: { branchName: 'feature/test', head: 'abc123' } },
      undefined,
      onForceDelete,
      onRelease,
      'cleanup-failed-delete'
    )
    const body = renderToastBody()
    const options = vi.mocked(toast.warning).mock.calls.at(-1)?.[1]

    clickButton(body, 'Force Delete Branch')
    await vi.waitFor(() => expect(onForceDelete).toHaveBeenCalledOnce())

    expect(toast.dismiss).not.toHaveBeenCalled()
    options?.onDismiss?.({ id: 'preserved-branch:cleanup-failed-delete' } as never)
    expect(onRelease).toHaveBeenCalledOnce()
  })

  it('uses distinct toast identities for identical branch heads', () => {
    const result = { preservedBranch: { branchName: 'feature/test', head: 'abc123' } }

    showPreservedBranchToast(result, undefined, vi.fn().mockResolvedValue(true), vi.fn(), 'first')
    showPreservedBranchToast(result, undefined, vi.fn().mockResolvedValue(true), vi.fn(), 'second')

    expect(vi.mocked(toast.warning).mock.calls.map(([, options]) => options?.id)).toEqual([
      'preserved-branch:first',
      'preserved-branch:second'
    ])
  })
})
