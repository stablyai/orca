import { useState } from 'react'
import { DndContext } from '@dnd-kit/core'
import { defineFixture } from '../../component-fixtures/component-fixture'
import type { TerminalTab } from '../../../../shared/workspace-layout/terminal-tab-types'
import { getDefaultSettings } from '../../../../shared/orca-profiles/constants'
import TabBar from './TabBar'

const WORKSPACE_ID = 'tab-width-mode-fixture'
const TITLES = [
  'hub',
  'api',
  'ui',
  'Codex Chat',
  'Should we regenerate the conversation title for this long session prompt?'
]
const noop = (): void => {}

function TabWidthModeStrip({ titles = TITLES }: { titles?: readonly string[] }): React.JSX.Element {
  const [activeTabId, setActiveTabId] = useState('tab-0')
  const tabs: TerminalTab[] = titles.map((title, index) => ({
    id: `tab-${index}`,
    worktreeId: WORKSPACE_ID,
    ptyId: null,
    title,
    customTitle: null,
    color: null,
    sortOrder: index,
    createdAt: 0,
    launchAgent: 'codex'
  }))

  return (
    <DndContext>
      <div className="@container/tab-strip h-8 bg-card">
        <TabBar
          tabs={tabs}
          activeTabId={activeTabId}
          activeTabType="terminal"
          worktreeId={WORKSPACE_ID}
          groupId="tab-width-mode-group"
          expandedPaneByTabId={{}}
          showAgentLaunchItems={false}
          onActivate={setActiveTabId}
          onClose={noop}
          onCloseOthers={noop}
          onCloseToRight={noop}
          onCloseToLeft={noop}
          onNewTerminalTab={noop}
          onNewBrowserTab={noop}
          onSetCustomTitle={noop}
          onSetTabColor={noop}
          onTogglePaneExpand={noop}
        />
      </div>
    </DndContext>
  )
}

async function nextFrames(count: number): Promise<void> {
  for (let index = 0; index < count; index++) {
    await new Promise((resolve) => requestAnimationFrame(resolve))
  }
}

export const defaultShortAndLong = defineFixture({
  width: 1100,
  render: () => <TabWidthModeStrip />
})

export const fitShortAndLong = defineFixture({
  width: 1100,
  store: {
    settings: { ...getDefaultSettings('/home/fixture'), tabWidthMode: 'fit' }
  },
  render: () => <TabWidthModeStrip />
})

export const fitCustomMaxWidth = defineFixture({
  width: 1100,
  store: {
    settings: { ...getDefaultSettings('/home/fixture'), tabWidthMode: 'fit', tabMaxWidth: 200 }
  },
  render: () => <TabWidthModeStrip />
})

export const fitOverflowing = defineFixture({
  width: 420,
  store: {
    settings: { ...getDefaultSettings('/home/fixture'), tabWidthMode: 'fit' }
  },
  render: () => (
    <TabWidthModeStrip titles={[...TITLES, 'Build server', 'Test runner', 'Migration plan']} />
  )
})

export const fitRenaming = defineFixture({
  width: 1100,
  store: {
    settings: { ...getDefaultSettings('/home/fixture'), tabWidthMode: 'fit' }
  },
  render: () => <TabWidthModeStrip />,
  interact: async (frame) => {
    await nextFrames(2)
    const firstTab = frame.querySelector<HTMLElement>('[data-testid="sortable-tab"]')
    if (!firstTab) {
      throw new Error('Missing first tab')
    }
    firstTab.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
    await nextFrames(3)
    const input = frame.querySelector<HTMLElement>('[data-tab-rename-input]')
    if (!input) {
      throw new Error('Rename input did not open')
    }
    const slot = input.closest<HTMLElement>('[data-tab-strip-slot]')
    if (!slot || Math.round(slot.getBoundingClientRect().width) < 290) {
      throw new Error(
        `Expected rename slot to widen to max width, got ${slot?.getBoundingClientRect().width}`
      )
    }
  }
})
