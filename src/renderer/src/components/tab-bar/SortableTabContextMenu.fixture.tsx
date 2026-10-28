import { FixtureCodeBackdrop } from '../../component-fixtures/FixtureCodeBackdrop'
import { defineFixture } from '../../component-fixtures/component-fixture'
import { SortableTabContextMenu } from './SortableTabContextMenu'

const noop = (): void => {}

export const open = defineFixture({
  width: 360,
  render: () => (
    <div className="relative h-[420px] overflow-hidden bg-background">
      <FixtureCodeBackdrop />
      <SortableTabContextMenu
        tab={{ id: 'tab-1', worktreeId: 'wt-1', color: null }}
        unifiedTabId="tab-1"
        groupId="group-1"
        isActive
        open
        point={{ x: 16, y: 8 }}
        tabCount={3}
        hasTabsToRight
        hasTabsToLeft={false}
        isPinned={false}
        onOpenChange={noop}
        onActivate={noop}
        onClose={noop}
        onCloseOthers={noop}
        onCloseToRight={noop}
        onCloseToLeft={noop}
        onRenameOpen={noop}
        onSetTabColor={noop}
        onTogglePin={noop}
      />
    </div>
  )
})
