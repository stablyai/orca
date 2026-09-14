import { beforeAll, describe, expect, it, vi } from 'vitest'
import type { Repo } from '../../../../shared/repo-types'
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
import {
  getCardOpeningTag,
  getDataNumber,
  getFlushCardContentStart,
  getOptionOpeningTag,
  getPaddingLeft
} from './worktree-list-card-markup-queries'
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

// Why: describe title is shared across the split files so test full names stay stable.
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

  it('passes child review details through the shared WorktreeCard path', async () => {
    setLineageFixtureState('none', {
      childWorktreeOverrides: { linkedPR: 456, linkedGitLabMR: 42 }
    })
    const markup = await renderWorktreeListMarkup()
    const childCard = getCardOpeningTag(markup, 'child')

    expect(childCard).toContain('data-linked-pr="456"')
    expect(childCard).toContain('data-linked-gitlab-mr="42"')
  })

  it('uses shared nested-row indentation for child and grandchild cards', async () => {
    setLineageFixtureState()
    const markup = await renderWorktreeListMarkup()

    expect(getOptionOpeningTag(markup, 'child')).toContain('padding-left:14px')
    expect(getCardOpeningTag(markup, 'child')).toContain('data-content-indent="0"')
    expect(getCardOpeningTag(markup, 'child')).toContain('data-flush-surface="true"')
    expect(getOptionOpeningTag(markup, 'grandchild')).toContain('padding-left:28px')
    expect(getCardOpeningTag(markup, 'grandchild')).toContain('data-content-indent="0"')
    expect(getCardOpeningTag(markup, 'grandchild')).toContain('data-flush-surface="true"')
  })

  it('shows deleting feedback on nested lineage child cards', async () => {
    setLineageFixtureState('none', { deletingWorktreeIds: ['child'] })
    const markup = await renderWorktreeListMarkup()
    const childCard = getCardOpeningTag(markup, 'child')
    const childIndex = markup.indexOf('data-worktree-card-id="child"')
    const childMarkup = markup.slice(
      childIndex,
      markup.indexOf('data-worktree-card-id="grandchild"')
    )

    expect(childCard).toContain('aria-busy="true"')
    expect(childMarkup).toContain('Deleting')
  })

  it('shows the unread bell action on unread nested lineage child cards', async () => {
    setLineageFixtureState('none', { unreadWorktreeIds: ['child'] })
    mockStore.state.worktreeCardProperties = ['status', 'inline-agents']
    const markup = await renderWorktreeListMarkup()
    const childIndex = markup.indexOf('data-worktree-card-id="child"')
    const childMarkup = markup.slice(
      childIndex,
      markup.indexOf('data-worktree-card-id="grandchild"')
    )

    expect(childMarkup).toContain('aria-label="Mark as read"')
    expect(childMarkup).not.toContain('aria-label="Mark as unread"')
  })

  it('lets WorktreeCard own the reconnect dialog for an active disconnected lineage child', async () => {
    setLineageFixtureState()
    const repo = (mockStore.state.repos as Repo[])[0]!
    repo.connectionId = 'ssh-target-1'
    mockStore.state.activeWorktreeId = 'child'
    mockStore.state.sshConnectionStates = new Map([['ssh-target-1', { status: 'disconnected' }]])
    mockStore.state.sshTargetLabels = new Map([['ssh-target-1', 'Remote target']])

    const markup = await renderWorktreeListMarkup()

    expect(getCardOpeningTag(markup, 'child')).toContain('data-worktree-card-active="true"')
    expect(markup).toContain('data-worktree-card-ssh-dialog="open"')
    expect(markup).not.toContain('data-lineage-ssh-dialog="open"')
    expect(markup).toContain('data-ssh-status="disconnected"')
    expect(markup).toContain('data-ssh-target-id="ssh-target-1"')
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

  it('opens inline rename only for the row-scoped lineage child request', async () => {
    setLineageFixtureState()
    mockStore.state.renamingWorktreeId = { worktreeId: 'child', rowKey: 'all:|child' }
    const markup = await renderWorktreeListMarkup()

    const childCard =
      markup.match(
        /<div id="worktree-list-option-all%3A%7Cchild"[\s\S]*?lineage child with agent/
      )?.[0] ?? ''
    const parentCard =
      markup.match(/<div id="worktree-list-option-all%3A%7Cparent"[\s\S]*?lineage parent/)?.[0] ??
      ''

    expect(childCard).toContain('data-begin-editing="true"')
    expect(parentCard).not.toContain('data-begin-editing="true"')
  })

  it('does not add group indentation when grouping is disabled', async () => {
    setLineageFixtureState('none')
    const markup = await renderWorktreeListMarkup()

    const parentRow = getOptionOpeningTag(markup, 'parent')

    expect(parentRow).toContain('id="worktree-list-option-all%3A%7Cparent"')
    expect(parentRow).not.toContain('padding-left')
  })

  it('passes one group indentation step into the card when grouped by project', async () => {
    setLineageFixtureState('repo')
    const markup = await renderWorktreeListMarkup()

    const parentRow = getOptionOpeningTag(markup, 'parent')

    expect(parentRow).not.toContain('padding-left')
    expect(getCardOpeningTag(markup, 'parent')).toContain('data-content-indent="20"')
    expect(getCardOpeningTag(markup, 'parent')).toContain('data-flush-surface="true"')
  })

  it('keeps nested card inner padding aligned with grouped parent cards', async () => {
    setLineageFixtureState('repo')
    const markup = await renderWorktreeListMarkup()

    expect(getOptionOpeningTag(markup, 'child')).toContain('padding-left:14px')
    expect(getCardOpeningTag(markup, 'child')).toContain('data-content-indent="6"')
    expect(getCardOpeningTag(markup, 'child')).toContain('data-flush-surface="true"')
  })

  it('keeps nested card inner padding aligned inside project groups', async () => {
    setLineageFixtureState('repo', { projectGrouped: true })
    const markup = await renderWorktreeListMarkup()

    expect(getOptionOpeningTag(markup, 'child')).toContain('padding-left:14px')
    expect(getCardOpeningTag(markup, 'child')).toContain('data-content-indent="24"')
    expect(getCardOpeningTag(markup, 'child')).toContain('data-flush-surface="true"')
  })

  it('adds project group depth to workspace card content indentation', async () => {
    setLineageFixtureState('repo', { projectGrouped: true })
    const markup = await renderWorktreeListMarkup()

    const parentRow = getOptionOpeningTag(markup, 'parent')

    expect(parentRow).toContain('padding-left:14px')
    expect(getCardOpeningTag(markup, 'parent')).toContain('data-content-indent="24"')
    expect(getCardOpeningTag(markup, 'parent')).toContain('data-flush-surface="true"')
  })

  it('keeps repo worktrees shallower inside folder-scanned project groups', async () => {
    setLineageFixtureState('repo', { folderBackedProjectGroup: true, projectGrouped: true })
    const markup = await renderWorktreeListMarkup()

    const parentRow = getOptionOpeningTag(markup, 'parent')
    const cardOpeningTag = getCardOpeningTag(markup, 'parent')
    const cardContentIndent = getDataNumber(cardOpeningTag, 'data-content-indent')

    expect(parentRow).toContain('padding-left:14px')
    expect(cardOpeningTag).toContain('data-content-indent="16"')
    expect(cardOpeningTag).toContain('data-flush-surface="true"')
    expect(
      getFlushCardContentStart({
        cardContentIndent,
        surfaceInset: getPaddingLeft(parentRow)
      })
    ).toBe(30)
  })

  it('caps deeply nested folder-scanned repo worktree surfaces at the compact anchor', async () => {
    setLineageFixtureState('repo', {
      folderBackedProjectGroup: true,
      projectGrouped: true,
      projectGroupDepth: 3
    })
    const markup = await renderWorktreeListMarkup()

    const parentRow = getOptionOpeningTag(markup, 'parent')
    const cardOpeningTag = getCardOpeningTag(markup, 'parent')
    const cardContentIndent = getDataNumber(cardOpeningTag, 'data-content-indent')

    expect(parentRow).toContain('padding-left:54px')
    expect(cardOpeningTag).toContain('data-content-indent="6"')
    expect(
      getFlushCardContentStart({
        cardContentIndent,
        surfaceInset: getPaddingLeft(parentRow)
      })
    ).toBe(60)
  })
})
