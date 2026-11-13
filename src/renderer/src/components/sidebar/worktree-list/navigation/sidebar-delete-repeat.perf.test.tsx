// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { createUIStore } from '@/store/slices/ui/ui-slice-test-harness'
import { useSidebarWorkspaceDeleteKeyboard } from './use-sidebar-workspace-delete-keyboard'
import { resolveSidebarWorkspaceDeleteIntent } from './sidebar-workspace-delete'
import { repo, worktree } from '../grouping/worktree-list-groups-test-fixtures'

const store = createUIStore()
vi.mock('@/store', () => ({ useAppStore: { getState: () => store.getState() } }))
vi.mock('../../workspace-actions/deletion/delete-worktree-flow', () => ({
  runWorktreeDelete: vi.fn(),
  runWorktreeBatchDelete: vi.fn()
}))
vi.mock('../../workspace-actions/deletion/folder-workspace-delete', () => ({
  deleteFolderWorkspaceUnlessUnsaved: vi.fn()
}))
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

it('resolves the initial delete gesture once and never resolves held repeats at fleet scale', () => {
  store.setState({ repos: [repo], deleteStateByWorktreeId: {} })
  for (const size of [750, 7500]) {
    const selectedWorktrees = Array.from({ length: size }, (_, index) => ({
      ...worktree,
      id: `primary-${index}`,
      isMainWorktree: true
    }))
    const resolve = vi.fn(() =>
      resolveSidebarWorkspaceDeleteIntent({
        selectedWorktrees,
        focusedWorktree: selectedWorktrees[0],
        repoMap: new Map([[repo.id, repo]])
      })
    )
    function Probe() {
      const keyboard = useSidebarWorkspaceDeleteKeyboard({
        keybindings: {},
        resolveDeleteIntent: resolve,
        dropPreview: () => {}
      })
      return <div tabIndex={0} onKeyDown={keyboard.handleDeleteKeyDown} />
    }
    const container = document.createElement('div')
    document.body.append(container)
    const root = createRoot(container)
    try {
      act(() => root.render(<Probe />))
      const target = container.firstElementChild!
      for (let index = 0; index < 21; index++) {
        act(() =>
          target.dispatchEvent(
            new KeyboardEvent('keydown', {
              bubbles: true,
              cancelable: true,
              key: 'Backspace',
              code: 'Backspace',
              shiftKey: true,
              metaKey: navigator.userAgent.includes('Mac'),
              ctrlKey: !navigator.userAgent.includes('Mac'),
              repeat: index > 0
            })
          )
        )
      }
      expect(resolve).toHaveBeenCalledTimes(1)
    } finally {
      act(() => root.unmount())
      container.remove()
    }
  }
})
