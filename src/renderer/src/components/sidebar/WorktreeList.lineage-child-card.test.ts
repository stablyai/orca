import { beforeAll, describe, expect, it, vi } from 'vitest'

import {
  createAppStoreModuleMock,
  createDropdownMenuModuleMock,
  createProjectHeaderDragModuleMock,
  createReactVirtualModuleMock,
  createTooltipModuleMock,
  createVirtualizedScrollAnchorModuleMock,
  createWorktreeCardAgentsModuleMock,
  createWorktreeCardModuleMock,
  createWorktreeContextMenuModuleMock,
  createWorktreeTitleInlineRenameModuleMock,
  loadWorktreeList,
  mockStore,
  renderWorktreeListMarkup
} from './worktree-list-lineage-card-test-harness'
import { getCardOpeningTag } from './worktree-list-card-markup-queries'

import { setLineageFixtureState } from './worktree-list-lineage-store-state'
import { setPinnedFixtureState } from './worktree-list-pinned-store-state'

vi.mock('@/store', () => createAppStoreModuleMock())
vi.mock('@tanstack/react-virtual', () => createReactVirtualModuleMock())
vi.mock('@/hooks/useVirtualizedScrollAnchor', () => createVirtualizedScrollAnchorModuleMock())
vi.mock('./project-header-drag', () => createProjectHeaderDragModuleMock())
vi.mock('./WorktreeCard', () => createWorktreeCardModuleMock())
vi.mock('./WorktreeCardAgents', () => createWorktreeCardAgentsModuleMock())
vi.mock('./WorktreeTitleInlineRename', () => createWorktreeTitleInlineRenameModuleMock())
vi.mock('./WorktreeContextMenu', () => createWorktreeContextMenuModuleMock())
vi.mock('@/components/ui/tooltip', () => createTooltipModuleMock())
vi.mock('@/components/ui/dropdown-menu', () => createDropdownMenuModuleMock())

describe('WorktreeList lineage child card renderer', () => {
  beforeAll(async () => {
    await loadWorktreeList()
  }, 60_000)

  it('renders recursive lineage descendants through WorktreeCard once', async () => {
    setLineageFixtureState()
    const markup = await renderWorktreeListMarkup()

    expect(markup.match(/data-worktree-card-id="parent"/g)).toHaveLength(1)
    expect(markup.match(/data-worktree-card-id="child"/g)).toHaveLength(1)
    expect(markup.match(/data-worktree-card-id="grandchild"/g)).toHaveLength(1)

    const parentIndex = markup.indexOf('data-worktree-card-id="parent"')
    const childIndex = markup.indexOf('data-worktree-card-id="child"')
    const grandchildIndex = markup.indexOf('data-worktree-card-id="grandchild"')

    expect(parentIndex).toBeGreaterThan(-1)
    expect(childIndex).toBeGreaterThan(parentIndex)
    expect(grandchildIndex).toBeGreaterThan(childIndex)
    expect(getCardOpeningTag(markup, 'child')).toContain('data-lineage-child-count="1"')
  })

  it('points aria-activedescendant at the active lineage child row', async () => {
    setLineageFixtureState()
    mockStore.state.activeWorktreeId = 'child'
    const markup = await renderWorktreeListMarkup()

    expect(markup).toContain('aria-activedescendant="worktree-list-option-all%3A%7Cchild"')
  })

  it('points aria-activedescendant at the pinned row for active pinned workspaces', async () => {
    setPinnedFixtureState()
    const markup = await renderWorktreeListMarkup()

    expect(markup).toContain('aria-activedescendant="worktree-list-option-pinned%3A%7Cpinned"')
    expect(markup).toContain('id="worktree-list-option-pinned%3A%7Cpinned"')
    expect(markup).not.toContain('id="worktree-list-option-all%3A%7Cpinned"')
  })

  it('points aria-activedescendant at the natural duplicate when enabled', async () => {
    setPinnedFixtureState()
    mockStore.state.settings = { showPinnedWorktreesInGroups: true }
    const markup = await renderWorktreeListMarkup()

    expect(markup).toContain('aria-activedescendant="worktree-list-option-all%3A%7Cpinned"')
    expect(markup).toContain('id="worktree-list-option-pinned%3A%7Cpinned"')
    expect(markup).toContain('id="worktree-list-option-all%3A%7Cpinned"')
  })
})
