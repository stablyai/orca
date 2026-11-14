import { DndContext } from '@dnd-kit/core'
import { defineFixture } from '../../component-fixtures/component-fixture'
import SortableTab from './SortableTab'
import { TabStripTooltipProvider } from './TabStripTooltipProvider'

const noop = (): void => {}

function ChatTab({
  id,
  title,
  forked,
  width,
  active = false
}: {
  id: string
  title: string
  forked: boolean
  width?: number
  active?: boolean
}): React.JSX.Element {
  return (
    <div className="flex h-8" style={width ? { width } : undefined}>
      <SortableTab
        tab={{ id, worktreeId: 'fixture', title, customTitle: null, color: null }}
        agent="claude"
        unifiedTabId={id}
        groupId="fixture-group"
        tabCount={3}
        hasTabsToRight
        hasTabsToLeft={false}
        isActive={active}
        isPinned={false}
        isExpanded={false}
        onActivate={noop}
        onClose={noop}
        onCloseOthers={noop}
        onCloseToRight={noop}
        onCloseToLeft={noop}
        onSetCustomTitle={noop}
        onSetTabColor={noop}
        onTogglePin={noop}
        onToggleExpand={noop}
        dragData={{
          kind: 'tab',
          worktreeId: 'fixture',
          groupId: 'fixture-group',
          unifiedTabId: id,
          visibleTabId: id,
          tabType: 'agent-session',
          label: title,
          color: null
        }}
        canSplitTerminal={false}
        fork={forked ? { describeSource: () => 'Fork of Annotate capabilities' } : undefined}
      />
    </div>
  )
}

function Strip({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <DndContext>
      <TabStripTooltipProvider>
        <div className="flex h-8 items-stretch bg-card">{children}</div>
      </TabStripTooltipProvider>
    </DndContext>
  )
}

export const defaultWidth = defineFixture({
  width: 1240,
  render: () => (
    <Strip>
      <ChatTab id="original" title="Annotate capabilities" forked={false} />
      <ChatTab id="fork" title="Annotate capabilities" forked active />
      <ChatTab id="fork-2" title="Plan the migration" forked />
      <ChatTab id="unnamed-fork" title="Claude Chat" forked />
    </Strip>
  )
})

export const narrow = defineFixture({
  width: 560,
  render: () => (
    <Strip>
      <ChatTab id="original" title="Annotate capabilities" forked={false} width={150} />
      <ChatTab id="fork" title="Annotate capabilities" forked active width={150} />
      <ChatTab id="fork-170" title="Annotate capabilities" forked width={170} />
    </Strip>
  )
})

export const hoverCard = defineFixture({
  width: 420,
  render: () => (
    <div className="h-40">
      <Strip>
        <ChatTab id="fork" title="Annotate capabilities" forked active />
      </Strip>
    </div>
  ),
  interact: (frame) => {
    frame.querySelector<HTMLElement>('[data-testid="sortable-tab"]')?.focus()
  }
})
