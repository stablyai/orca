// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ConfirmationDialogProvider } from '@/components/confirmation-dialog'
import {
  requestScrollToCurrentWorkspaceReveal,
  requestScrollToCurrentWorkspaceRevealAndRename
} from '@/lib/scroll-to-current-workspace-status'
import { folderWorkspaceKey } from '../../../../../../shared/workspace-scope'
import { useSidebarRevealRequests } from './use-reveal-requests'
import type { Worktree } from '../../../../../../shared/worktree/types'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

const state = vi.hoisted(() => ({
  setGroupBy: vi.fn(),
  pendingRevealSidebarRow: null,
  revealSidebarRow: vi.fn(),
  revealWorktreeInSidebar: vi.fn(),
  setContextualToursBlockingSurfaceVisible: vi.fn()
}))
vi.mock('@/store', () => ({
  useAppStore: (selector: (value: typeof state) => unknown) => selector(state)
}))

type Args = Parameters<typeof useSidebarRevealRequests>[0]
function Host({ args }: { args: Args }): null {
  useSidebarRevealRequests(args)
  return null
}

let root: Root
let container: HTMLDivElement
let args: Args

async function render(): Promise<void> {
  await act(async () => {
    root.render(
      <ConfirmationDialogProvider>
        <Host args={args} />
      </ConfirmationDialogProvider>
    )
  })
}

async function click(label: string): Promise<void> {
  const button = Array.from(document.querySelectorAll('button')).find(
    (candidate) => candidate.textContent === label
  )
  expect(button).toBeDefined()
  await act(async () => button!.click())
}

beforeEach(() => {
  vi.clearAllMocks()
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  const worktree: Worktree = {
    id: 'wt-1',
    hostId: 'ssh:dev',
    repoId: 'repo-1',
    path: '/repo/feature',
    displayName: 'Feature',
    branch: 'feature',
    head: 'abc123',
    isBare: false,
    isMainWorktree: false,
    comment: '',
    linkedIssue: null,
    linkedPR: null,
    linkedLinearIssue: null,
    linkedGitLabMR: null,
    linkedGitLabIssue: null,
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 1,
    lastActivityAt: 1
  }
  args = {
    groupBy: 'repo',
    renderedSidebarRowKeys: new Set(),
    renderedWorktreeIdentities: [],
    currentSidebarWorktreeId: worktree.id,
    currentSidebarExecutionHostId: 'ssh:dev',
    worktreeMap: new Map([[worktree.id, worktree]]),
    worktrees: [worktree],
    folderWorkspaces: [],
    hasFilters: true,
    clearFilters: vi.fn()
  }
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
})

describe('revealing a filtered workspace', () => {
  it('explains the filter reset and leaves filters intact when dismissed', async () => {
    await render()
    await act(async () => requestScrollToCurrentWorkspaceReveal())
    expect(document.body.textContent).toContain('Revealing it will clear your sidebar filters.')
    expect(args.clearFilters).not.toHaveBeenCalled()
    expect(state.revealWorktreeInSidebar).not.toHaveBeenCalled()
    await click('Keep filters')
    expect(args.clearFilters).not.toHaveBeenCalled()
    expect(state.revealWorktreeInSidebar).not.toHaveBeenCalled()
  })

  it('clears filters and reveals on the original execution host only after confirmation', async () => {
    await render()
    await act(async () => {
      requestScrollToCurrentWorkspaceReveal()
      requestScrollToCurrentWorkspaceReveal()
    })
    await click('Clear filters and reveal')
    expect(args.clearFilters).toHaveBeenCalledTimes(1)
    expect(state.revealWorktreeInSidebar).toHaveBeenCalledWith('wt-1', {
      behavior: 'smooth',
      highlight: true,
      beginRename: false,
      executionHostId: 'ssh:dev'
    })
    expect(document.querySelector('[role="dialog"]')).toBeNull()
  })

  it.each([true, false])(
    'reveals immediately when clearing filters is unnecessary (%s)',
    async (visible) => {
      args = {
        ...args,
        hasFilters: visible,
        renderedWorktreeIdentities: visible ? ['ssh:dev|wt-1'] : []
      }
      await render()
      await act(async () => requestScrollToCurrentWorkspaceReveal())
      expect(document.querySelector('[role="dialog"]')).toBeNull()
      expect(args.clearFilters).not.toHaveBeenCalled()
      expect(state.revealWorktreeInSidebar).toHaveBeenCalledTimes(1)
    }
  )

  it('does not apply a stale confirmation after switching workspaces', async () => {
    await render()
    await act(async () => requestScrollToCurrentWorkspaceReveal())
    args = { ...args, currentSidebarWorktreeId: 'wt-2' }
    await render()
    await click('Clear filters and reveal')
    expect(args.clearFilters).not.toHaveBeenCalled()
    expect(state.revealWorktreeInSidebar).not.toHaveBeenCalled()
  })

  it('confirms filtered folder workspaces and preserves the rename request', async () => {
    args = {
      ...args,
      currentSidebarWorktreeId: folderWorkspaceKey('folder-1'),
      currentSidebarExecutionHostId: null,
      folderWorkspaces: [
        {
          id: 'folder-1',
          projectGroupId: 'project-1',
          name: 'Notes',
          folderPath: '/notes',
          linkedTask: null,
          comment: '',
          isArchived: false,
          isUnread: false,
          isPinned: false,
          sortOrder: 1,
          lastActivityAt: 1,
          createdAt: 1,
          updatedAt: 1
        }
      ]
    }
    await render()
    await act(async () => requestScrollToCurrentWorkspaceRevealAndRename())
    expect(args.clearFilters).not.toHaveBeenCalled()
    await click('Clear filters and reveal')
    expect(args.clearFilters).toHaveBeenCalledTimes(1)
    expect(state.revealWorktreeInSidebar).toHaveBeenCalledWith(folderWorkspaceKey('folder-1'), {
      behavior: 'smooth',
      highlight: true,
      beginRename: true,
      executionHostId: undefined
    })
  })
})
