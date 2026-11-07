// @vitest-environment happy-dom
import { useEffect, useState, type ComponentProps } from 'react'
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { WorkspaceCreateMenu } from '@/components/tab-bar/WorkspaceCreateMenu'
import { WorktreeCreateButton } from './WorktreeCreateButton'

const handoff = vi.hoisted(
  (): {
    pending: (() => void) | null
    target: HTMLTextAreaElement | null
    creation: Promise<void>
  } => ({
    pending: null,
    target: null,
    creation: Promise.resolve()
  })
)
vi.mock('@/i18n/i18n', () => ({ translate: (_key: string, fallback: string) => fallback }))
vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => ({
      activeWorktreeId: 'wt',
      activeWorkspaceExecutionHostId: 'local',
      activeGroupIdByWorktree: { wt: 'group' },
      groupsByWorktree: {},
      openNewTerminalTabInActiveWorkspace: () => handoff.creation
    })
  }
}))
vi.mock('@/lib/workspace/activation/worktree-activation', () => ({
  activateAndRevealWorktree: () => true
}))
vi.mock('./restore-worktree-create-menu-surface', () => ({
  restoreWorktreeCreateMenuSurface: () => {}
}))
vi.mock('@/components/tab-group/useTabGroupWorkspaceModel', () => ({
  useTabGroupWorkspaceModel: () => ({ commands: {}, terminalTabs: [], expandedPaneByTabId: {} })
}))
vi.mock('@/components/tab-bar/use-tab-bar-runtime-model', () => ({
  useTabBarRuntimeModel: () => ({ resolvedGroupId: 'group' })
}))
vi.mock('@/components/tab-bar/use-plugin-new-file-menu-options', () => ({
  usePluginNewFileMenuOptions: () => ({ menuOptions: [] })
}))
vi.mock('@/components/tab-bar/use-tab-bar-create-menu-controller', () => ({
  useTabBarCreateMenuController: () => {
    const [newTabMenuOpen, setNewTabMenuOpen] = useState(true)
    return {
      newTabMenuOpen,
      setNewTabMenuOpen,
      runPendingNewTabMenuFocusAfterClose: () => {
        handoff.pending = () => handoff.target?.focus()
      },
      clearPendingNewTabMenuFocusOnUnmount: () => {
        handoff.pending = null
      }
    }
  }
}))
vi.mock('@/components/tab-bar/WorkspaceCreateMenu', () => ({
  WorkspaceCreateMenu: ({
    trigger,
    props,
    createMenu,
    onClosed,
    onOpenChange
  }: ComponentProps<typeof WorkspaceCreateMenu>) => {
    const { newTabMenuOpen, runPendingNewTabMenuFocusAfterClose } = createMenu
    useEffect(() => {
      if (!newTabMenuOpen) {
        runPendingNewTabMenuFocusAfterClose()
        onClosed?.()
      }
    }, [newTabMenuOpen, runPendingNewTabMenuFocusAfterClose, onClosed])
    return (
      <div>
        {trigger}
        {newTabMenuOpen ? (
          <button
            onClick={() => {
              props.onNewTerminalTab()
              onOpenChange?.(false)
              createMenu.setNewTabMenuOpen(false)
            }}
          >
            Create terminal
          </button>
        ) : null}
      </div>
    )
  }
}))
afterEach(() => {
  cleanup()
  handoff.target?.remove()
  handoff.pending = null
})

it.each(['normal', 'abandoned'] as const)(
  'keeps the deferred terminal handoff only after a %s close',
  async (kind) => {
    const completion = Promise.withResolvers<void>()
    handoff.creation = completion.promise
    handoff.target = document.createElement('textarea')
    document.body.append(handoff.target)
    const view = render(<WorktreeCreateButton worktreeId="wt" executionHostId="local" />)
    fireEvent.click(view.getByRole('button', { name: 'New tab' }))
    await act(async () => {
      fireEvent.click(view.getByRole('button', { name: 'Create terminal' }))
    })
    if (kind === 'abandoned') {
      view.unmount()
    }
    await act(async () => {
      completion.resolve()
      await completion.promise
    })
    await waitFor(() => expect(view.queryByRole('button', { name: 'Create terminal' })).toBeNull())
    act(() => handoff.pending?.())
    if (kind === 'normal') {
      expect(document.activeElement).toBe(handoff.target)
    } else {
      expect(document.activeElement).not.toBe(handoff.target)
    }
  }
)
