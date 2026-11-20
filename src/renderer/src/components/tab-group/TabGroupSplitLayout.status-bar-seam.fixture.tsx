// Where tab groups meet the status bar: split groups must show the same single line as one group.
import { defineFixture } from '../../component-fixtures/component-fixture'
import { useAppStore } from '@/store/index'
import { ConfirmationDialogProvider } from '../dismiss/confirmation/confirmation-dialog'
import TabGroupSplitLayout from './TabGroupSplitLayout'

const WT = 'preview-repo::/preview/repo/feature'

const store = {
  repos: [
    { id: 'preview-repo', path: '/preview/repo', displayName: 'repo', badgeColor: '', addedAt: 1 }
  ],
  worktreesByRepo: {
    'preview-repo': [
      {
        id: WT,
        repoId: 'preview-repo',
        path: '/preview/repo/feature',
        displayName: 'feature',
        branch: 'feature',
        head: 'abc123',
        isBare: false,
        isMainWorktree: false,
        comment: '',
        linkedIssue: null,
        linkedPR: null,
        linkedLinearIssue: null,
        isArchived: false,
        isUnread: false,
        isPinned: false,
        sortOrder: 0,
        lastActivityAt: 1
      }
    ]
  },
  activeWorktreeId: WT,
  unifiedTabsByWorktree: { [WT]: [] },
  groupsByWorktree: {},
  layoutByWorktree: {},
  activeGroupIdByWorktree: {}
}

function Workspace(): React.JSX.Element {
  const layout = useAppStore((state) => state.layoutByWorktree[WT])
  const focusedGroupId = useAppStore((state) => state.activeGroupIdByWorktree[WT])
  return (
    <ConfirmationDialogProvider>
      <div className="flex h-[240px] flex-col bg-background">
        <div className="relative flex min-h-0 flex-1">
          {layout ? (
            <TabGroupSplitLayout
              layout={layout}
              worktreeId={WT}
              focusedGroupId={focusedGroupId}
              isWorktreeActive
            />
          ) : null}
        </div>
        {/* Same chrome as the app's status bar row. */}
        <div className="h-6 min-h-[24px] shrink-0 border-t border-border bg-[var(--bg-titlebar,var(--card))]" />
      </div>
    </ConfirmationDialogProvider>
  )
}

function openSplit(focus: 'left' | 'right'): void {
  const state = useAppStore.getState()
  state.createUnifiedTab(WT, 'editor', { label: 'left.ts' })
  const leftGroupId = useAppStore.getState().activeGroupIdByWorktree[WT]
  if (!leftGroupId) {
    return
  }
  state.createEmptySplitGroup(WT, leftGroupId, 'right', { activate: true })
  useAppStore.getState().createUnifiedTab(WT, 'editor', { label: 'right.ts' })
  if (focus === 'left') {
    useAppStore.getState().focusGroup(WT, leftGroupId)
  }
}

export const singleGroup = defineFixture({
  width: 640,
  store,
  setup: () => {
    useAppStore.getState().createUnifiedTab(WT, 'editor', { label: 'left.ts' })
  },
  render: () => <Workspace />
})

export const splitFocusLeft = defineFixture({
  width: 640,
  store,
  setup: () => openSplit('left'),
  render: () => <Workspace />
})

export const splitFocusRight = defineFixture({
  width: 640,
  store,
  setup: () => openSplit('right'),
  render: () => <Workspace />
})
