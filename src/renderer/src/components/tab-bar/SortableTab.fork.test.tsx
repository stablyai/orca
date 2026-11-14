// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import { DndContext } from '@dnd-kit/core'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import SortableTab from './SortableTab'

afterEach(cleanup)

const noop = (): void => {}

function renderChatTab(fork: boolean): void {
  render(
    <DndContext>
      <TooltipProvider>
        <SortableTab
          tab={{ id: 'chat', worktreeId: 'w', title: 'Annotate', customTitle: null, color: null }}
          agent="claude"
          unifiedTabId="chat"
          groupId="g"
          tabCount={1}
          hasTabsToRight={false}
          hasTabsToLeft={false}
          isActive
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
            worktreeId: 'w',
            groupId: 'g',
            unifiedTabId: 'chat',
            visibleTabId: 'chat',
            tabType: 'agent-session',
            label: 'Annotate',
            color: null
          }}
          canSplitTerminal={false}
          fork={
            fork
              ? { describeSource: () => 'Fork of Annotate', markedTitle: 'Fork · Annotate' }
              : undefined
          }
        />
      </TooltipProvider>
    </DndContext>
  )
}

it("names a fork tab's close button after its marked title", () => {
  renderChatTab(true)
  expect(screen.getByRole('button', { name: 'Close tab Fork · Annotate' })).toBeInTheDocument()
  expect(screen.getByText('Fork: Annotate')).toBeInTheDocument()
})

it('keeps the plain title on an original chat tab', () => {
  renderChatTab(false)
  expect(screen.getByRole('button', { name: 'Close tab Annotate' })).toBeInTheDocument()
})
