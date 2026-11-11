import { useEffect, useRef } from 'react'
import { ContextMenu, ContextMenuTrigger } from '@/components/ui/context-menu'
import { FixtureCodeBackdrop } from '../../component-fixtures/FixtureCodeBackdrop'
import { defineFixture } from '../../component-fixtures/component-fixture'
import { SortableTabContextMenu } from './SortableTabContextMenu'

const noop = (): void => {}
const WORKSPACE_ID = 'repo-1::/preview/orca'

export const open = defineFixture({
  width: 360,
  store: {
    repos: [
      { id: 'repo-1', path: '/preview/orca', displayName: 'orca', badgeColor: '', addedAt: 1 }
    ],
    worktreesByRepo: {
      'repo-1': [
        {
          id: WORKSPACE_ID,
          repoId: 'repo-1',
          hostId: 'local',
          path: '/preview/orca',
          displayName: 'orca',
          branch: 'main',
          head: 'abc123',
          isBare: false,
          isMainWorktree: true,
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
    }
  },
  render: () => <MenuFixture />
})

function MenuFixture(): React.JSX.Element {
  const trigger = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    trigger.current?.dispatchEvent(
      new MouseEvent('contextmenu', { bubbles: true, clientX: 16, clientY: 8 })
    )
  }, [])
  return (
    <div className="relative h-[420px] overflow-hidden bg-background">
      <FixtureCodeBackdrop />
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <button ref={trigger}>Tab</button>
        </ContextMenuTrigger>
        <SortableTabContextMenu
          open
          tab={{ id: 'tab-1', worktreeId: WORKSPACE_ID, color: null }}
          unifiedTabId="tab-1"
          groupId="group-1"
          isActive
          tabCount={3}
          hasTabsToRight
          hasTabsToLeft={false}
          isPinned={false}
          onActivate={noop}
          onClose={noop}
          onCloseOthers={noop}
          onCloseToRight={noop}
          onCloseToLeft={noop}
          onRenameOpen={noop}
          onSetTabColor={noop}
          onTogglePin={noop}
        />
      </ContextMenu>
    </div>
  )
}
