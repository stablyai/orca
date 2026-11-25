// Side-by-side split groups each keep an active tab, but only the focused group's active tab carries
// the accent underline; the other group's active tab keeps its active fill and text, without the underline.
import { defineFixture } from '../../component-fixtures/component-fixture'
import { useAppStore } from '@/store/index'
import { ConfirmationDialogProvider } from '../dismiss/confirmation/confirmation-dialog'
import TabGroupSplitLayout from './TabGroupSplitLayout'

const WT = 'preview-repo::/preview/repo/feature'

/** Opens a seeded file as an editor tab; the strip labels a tab from its open file. */
function fileInit(name: string): { entityId: string; label: string } {
  return { entityId: `/preview/repo/feature/${name}`, label: name }
}

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
  openFiles: ['notes.ts', 'plan.ts', 'review.ts', 'config.ts'].map((name) => ({
    id: `/preview/repo/feature/${name}`,
    filePath: `/preview/repo/feature/${name}`,
    relativePath: name,
    worktreeId: WT,
    language: 'typescript',
    isDirty: false,
    mode: 'edit' as const
  })),
  unifiedTabsByWorktree: { [WT]: [] },
  groupsByWorktree: {},
  layoutByWorktree: {},
  activeGroupIdByWorktree: {}
}

// A theme with a blue tab indicator, as in the report; the built-in themes draw it in the foreground color.
const BLUE_INDICATOR: React.CSSProperties & Record<`--${string}`, string> = {
  '--tab-active-indicator': '#4781EE'
}

function Workspace({ style }: { style?: React.CSSProperties }): React.JSX.Element {
  const layout = useAppStore((state) => state.layoutByWorktree[WT])
  // Same source the workspace surface uses: the last focused group, not DOM focus.
  const focusedGroupId = useAppStore((state) => state.activeGroupIdByWorktree[WT])
  return (
    <ConfirmationDialogProvider>
      <div className="relative flex h-[120px] border border-border bg-background" style={style}>
        {layout ? (
          <TabGroupSplitLayout
            layout={layout}
            worktreeId={WT}
            focusedGroupId={focusedGroupId}
            isWorktreeActive
          />
        ) : null}
      </div>
    </ConfirmationDialogProvider>
  )
}

/** Two tabs in the first group; returns its id. */
function seedLeftGroup(): string {
  const state = useAppStore.getState()
  state.createUnifiedTab(WT, 'editor', fileInit('notes.ts'))
  const second = state.createUnifiedTab(WT, 'editor', fileInit('plan.ts'))
  return second.groupId
}

/** Splits a second group to the right with two tabs; returns its id. */
function seedRightGroup(leftGroupId: string): string {
  const state = useAppStore.getState()
  const first = state.createUnifiedTabInSplit(
    WT,
    'editor',
    { sourceGroupId: leftGroupId, splitDirection: 'right' },
    fileInit('review.ts')
  )
  if (!first) {
    throw new Error('split group was not created')
  }
  state.createUnifiedTab(WT, 'editor', { ...fileInit('config.ts'), targetGroupId: first.groupId })
  return first.groupId
}

export const focusLeftGroup = defineFixture({
  width: 1280,
  store,
  setup: () => {
    const left = seedLeftGroup()
    seedRightGroup(left)
    useAppStore.getState().focusGroup(WT, left)
  },
  render: () => <Workspace />
})

export const focusRightGroup = defineFixture({
  width: 1280,
  store,
  setup: () => {
    const left = seedLeftGroup()
    const right = seedRightGroup(left)
    useAppStore.getState().focusGroup(WT, right)
  },
  render: () => <Workspace />
})

export const singleGroup = defineFixture({
  width: 1280,
  store,
  setup: () => {
    seedLeftGroup()
  },
  render: () => <Workspace />
})

export const focusRightGroupBlueIndicator = defineFixture({
  width: 1280,
  store,
  setup: () => {
    const left = seedLeftGroup()
    const right = seedRightGroup(left)
    useAppStore.getState().focusGroup(WT, right)
  },
  render: () => <Workspace style={BLUE_INDICATOR} />
})
