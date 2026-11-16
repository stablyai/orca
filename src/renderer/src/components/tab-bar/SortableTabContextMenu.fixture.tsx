import { useEffect, useRef } from 'react'
import { ContextMenu, ContextMenuTrigger } from '@/components/ui/context-menu'
import { FixtureCodeBackdrop } from '../../component-fixtures/FixtureCodeBackdrop'
import { defineFixture } from '../../component-fixtures/component-fixture'
import { SortableTabContextMenu } from './SortableTabContextMenu'

const noop = (): void => {}

export const open = defineFixture({
  width: 360,
  render: function MenuFixture() {
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
            tab={{ id: 'tab-1', worktreeId: 'wt-1', color: null }}
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
})
