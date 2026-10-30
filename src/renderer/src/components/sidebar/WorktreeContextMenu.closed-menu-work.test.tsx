/**
 * @vitest-environment happy-dom
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Worktree } from '../../../../shared/worktree/types'
import { useAppStore } from '@/store'
import { makeLineage, makeWorktree } from '../../store/slices/worktrees-slice-test-fixtures'
import WorktreeContextMenu from './WorktreeContextMenu'
import type * as WorkspaceDeleteLineageModule from './workspace-delete-lineage'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

const lineageTraversals = vi.hoisted(() => ({ count: 0 }))

vi.mock('./workspace-delete-lineage', async (importOriginal) => {
  const actual = await importOriginal<typeof WorkspaceDeleteLineageModule>()
  return {
    getWorkspaceDeleteLineage: (...args: Parameters<typeof actual.getWorkspaceDeleteLineage>) => {
      lineageTraversals.count += 1
      return actual.getWorkspaceDeleteLineage(...args)
    }
  }
})

vi.mock('@/store', async () => {
  const { create } = await import('zustand')
  const noop = (): void => {}
  return {
    useAppStore: create<Record<string, unknown>>(() => ({
      unifiedTabsByWorktree: {},
      agentStatusByPaneKey: {},
      structuredChatSleptAtByPaneKey: {},
      updateWorktreeMeta: noop,
      setWorkspaceUnreadByUser: noop,
      setWorktreesPinnedAndReveal: noop,
      workspaceStatuses: [],
      hostWorkspaceStatuses: {},
      removedRuntimeEnvironmentIds: [],
      openModal: noop,
      projectGroups: [],
      createProjectGroup: noop,
      moveProjectToGroup: noop,
      deleteStateByWorktreeId: {},
      worktreeLineageById: {},
      workspaceLineageByChildKey: {},
      updateWorktreeLineage: noop,
      tabsByWorktree: {},
      ptyIdsByTabId: {},
      browserTabsByWorktree: {},
      worktreesByRepo: {},
      repos: []
    }))
  }
})

vi.mock('@/components/ui/dropdown-menu', () => {
  const Passthrough = (props: { children?: React.ReactNode }) => <div>{props.children}</div>
  return {
    DropdownMenu: (props: { children?: React.ReactNode; open?: boolean }) =>
      props.open ? <div data-testid="open-menu">{props.children}</div> : null,
    DropdownMenuContent: Passthrough,
    DropdownMenuItem: Passthrough,
    DropdownMenuSeparator: () => <hr />,
    DropdownMenuShortcut: Passthrough,
    DropdownMenuLabel: Passthrough,
    DropdownMenuSub: Passthrough,
    DropdownMenuSubContent: Passthrough,
    DropdownMenuSubTrigger: Passthrough,
    DropdownMenuTrigger: Passthrough,
    DropdownMenuRadioGroup: Passthrough,
    DropdownMenuRadioItem: Passthrough
  }
})

vi.mock('@/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: React.ReactNode }) => <>{children}</>
}))
vi.mock('lucide-react', async () =>
  (await import('../tab-bar/lucide-icon-stub-fixture')).stubEveryIcon()
)
vi.mock('@/i18n/i18n', () => ({
  i18n: { language: 'en' },
  translate: (_key: string, fallback: string) => fallback
}))
vi.mock('@/hooks/useShortcutLabel', () => ({
  useOptionalShortcutLabel: () => null,
  formatShortcutLabel: () => '',
  formatOptionalShortcutLabel: () => null
}))
vi.mock('./WorktreeDeveloperMenu', () => ({ WorktreeDeveloperMenu: () => null }))
vi.mock('./WorktreeOpenInMenu', () => ({ WorktreeOpenInSubMenu: () => null }))
vi.mock('./WorkspaceSleepMenuItems', () => ({ WorkspaceSleepMenuItems: () => null }))

const mounted: { container: HTMLDivElement; root: Root }[] = []

afterEach(() => {
  for (const { root, container } of mounted) {
    act(() => root.unmount())
    container.remove()
  }
  mounted.length = 0
})

function row(id: string, sortOrder = 0): Worktree {
  return makeWorktree({
    id: `repo::/w/${id}`,
    repoId: 'repo',
    instanceId: `${id}-instance`,
    hostId: 'local',
    path: `/w/${id}`,
    sortOrder
  })
}

describe('closed WorktreeContextMenu', () => {
  it('skips lineage traversal for rank churn, then opens with the current descendants', () => {
    const rows = Array.from({ length: 200 }, (_, index) => row(`w${index}`, index))
    useAppStore.setState({ worktreesByRepo: { repo: rows } })
    for (const worktree of rows.slice(0, 40)) {
      const container = document.createElement('div')
      document.body.appendChild(container)
      const root = createRoot(container)
      act(() => root.render(<WorktreeContextMenu worktree={worktree}>card</WorktreeContextMenu>))
      mounted.push({ container, root })
    }
    lineageTraversals.count = 0

    for (let burst = 0; burst < 9; burst += 1) {
      act(() =>
        useAppStore.setState({
          worktreesByRepo: { repo: rows.map((item) => ({ ...item, sortOrder: burst })) }
        })
      )
    }
    expect(lineageTraversals.count).toBe(0)

    // A child linked while every menu was closed must appear on the next open.
    const parent = rows[0]
    const child = rows[1]
    act(() =>
      useAppStore.setState({
        worktreeLineageById: {
          [child.id]: makeLineage({
            worktreeId: child.id,
            worktreeInstanceId: child.instanceId,
            parentWorktreeId: parent.id,
            parentWorktreeInstanceId: parent.instanceId
          })
        }
      })
    )
    const scope = mounted[0].container.querySelector('[data-worktree-context-menu-scope]')
    act(() => {
      scope?.dispatchEvent(
        new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 1, clientY: 1 })
      )
    })
    expect(lineageTraversals.count).toBeGreaterThan(0)
    expect(mounted[0].container.textContent).toContain('Delete with Descendants…')
  })
})
