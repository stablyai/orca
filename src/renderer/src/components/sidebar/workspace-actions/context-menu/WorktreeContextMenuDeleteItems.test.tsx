// @vitest-environment happy-dom
import { act, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import type { AppState } from '@/store/types'
import { makeWorktree } from '@/store/slices/worktrees/worktree.test-fixture'
import type { WorktreeContextMenuModel } from './use-worktree-context-menu-model'

const mocks = vi.hoisted(() => ({ state: {} as AppState }))
vi.mock('@/store', () => ({
  useAppStore: (select: (s: AppState) => unknown) => select(mocks.state)
}))
vi.mock('@/hooks/useShortcutLabel', () => ({ useOptionalShortcutLabel: () => '⌘⇧⌫' }))
vi.mock('@/i18n/use-translate', () => ({
  useTranslate: () => (_key: string, fallback: string) => fallback
}))
vi.mock('@/components/ui/dropdown-menu', () => ({
  DropdownMenuItem: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DropdownMenuShortcut: ({ children }: { children: ReactNode }) => <kbd>{children}</kbd>
}))
import { WorktreeContextMenuDeleteItems } from './WorktreeContextMenuDeleteItems'

it('advertises the shortcut only on the committed paired copy when physical host and instance match', () => {
  const inactive = makeWorktree({
    id: 'repo::/checkout',
    repoId: 'repo',
    hostId: 'ssh:builder',
    runtimeOwnerEnvironmentId: 'server-b'
  })
  const active = { ...inactive, runtimeOwnerEnvironmentId: 'server-a' }
  mocks.state = {
    activeView: 'terminal',
    activeWorktreeId: active.id,
    activeWorkspaceExecutionHostId: 'runtime:server-a',
    activePendingCreationId: null,
    pendingWorktreeCreations: {},
    worktreesByRepo: { repo: [inactive, active] },
    repos: [],
    folderWorkspaces: [],
    projectGroups: [],
    deleteStateByWorktreeId: {}
  } as unknown as AppState
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  const model = (worktree: typeof inactive) =>
    ({
      worktree,
      batchDeleteWorktrees: [],
      contextDeletePending: false,
      handleDelete: vi.fn(),
      isMultiContext: false,
      lineageDescendantCount: 0,
      removesProject: false
    }) as unknown as WorktreeContextMenuModel
  try {
    act(() =>
      root.render(
        <>
          <section data-copy="inactive">
            <WorktreeContextMenuDeleteItems model={model(inactive)} />
          </section>
          <section data-copy="active">
            <WorktreeContextMenuDeleteItems model={model(active)} />
          </section>
        </>
      )
    )
    expect(container.querySelector('[data-copy="inactive"] kbd')).toBeNull()
    expect(container.querySelector('[data-copy="active"] kbd')).not.toBeNull()
  } finally {
    act(() => root.unmount())
    container.remove()
  }
})
