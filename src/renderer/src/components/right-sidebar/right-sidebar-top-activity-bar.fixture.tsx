import { useState } from 'react'
import { Activity, Files, Plug } from 'lucide-react'
import { SidebarToggleIcon } from '@/components/icons/SidebarToggleIcon'
import { defineFixture } from '../../component-fixtures/component-fixture'
import type { ActiveRightSidebarTab } from '../../../../shared/ui-chrome/ui-chrome-types'
import type { ActivityBarItem } from './activity-bar/activity-bar-buttons'
import { getTopActivityBarLayout } from './activity-bar/activity-bar-overflow'
import { getPluginPanelActivityItems } from './plugin-panels/plugin-panel-activity-items'
import { getVisibleRightSidebarActivityItems } from './activity-bar/right-sidebar-activity-visibility'
import { useMeasuredWidth } from './layout/right-sidebar-measured-width'
import { RIGHT_SIDEBAR_TOP_ACTIVITY_STRIP_PADDING } from './layout/right-sidebar-titlebar-drag-regions'
import { RightSidebarTopActivityBar } from './activity-bar/right-sidebar-top-activity-bar'

const BOT_PAGE_ITEMS: ActivityBarItem[] = [
  {
    id: 'bot-activity',
    icon: Activity,
    title: 'Activity',
    shortcut: '',
    botOnly: true,
    labeledTab: true
  },
  {
    id: 'bot-connectors',
    icon: Plug,
    title: 'Connectors',
    shortcut: '',
    botPageOnly: true,
    labeledTab: true
  },
  { id: 'explorer', icon: Files, title: 'Files', shortcut: '', onBotPage: true, labeledTab: true }
]

// Measures its strip and opens the tab you pick, as the sidebar does, so More can be used.
function BotPageBar({
  width,
  activeTab: initialTab,
  items = BOT_PAGE_ITEMS
}: {
  width: number
  activeTab: ActiveRightSidebarTab
  items?: ActivityBarItem[]
}): React.JSX.Element {
  const [activeTab, setActiveTab] = useState(initialTab)
  const [stripWidth, setStripWidth] = useState<number | null>(null)
  const stripRef = useMeasuredWidth(setStripWidth)
  return (
    <div className="bg-sidebar text-foreground" style={{ width }}>
      <RightSidebarTopActivityBar
        hasDesktopWindowChrome={false}
        topActivityStripRef={stripRef}
        topActivityLayout={getTopActivityBarLayout(
          items,
          stripWidth,
          activeTab,
          RIGHT_SIDEBAR_TOP_ACTIVITY_STRIP_PADDING
        )}
        effectiveTab={activeTab}
        onSelectTab={setActiveTab}
        checksStatus={null}
        closeButton={
          <button type="button" className="sidebar-toggle mr-1" aria-label="Toggle right sidebar">
            <SidebarToggleIcon side="right" size={16} />
          </button>
        }
        activityBarPosition="top"
        onChangeActivityBarPosition={() => {}}
      />
      <div className="h-6" />
    </div>
  )
}

export const connectorsOpen = defineFixture({
  width: 440,
  render: () => <BotPageBar width={400} activeTab="bot-connectors" />
})

export const activityOpenWithCount = defineFixture({
  width: 440,
  render: () => (
    <BotPageBar
      width={400}
      activeTab="bot-activity"
      items={BOT_PAGE_ITEMS.map((item) =>
        item.id === 'bot-activity' ? { ...item, count: 2, countLabel: '2 need you' } : item
      )}
    />
  )
})

export const narrowest = defineFixture({
  width: 260,
  render: () => <BotPageBar width={220} activeTab="bot-connectors" />
})

// A closed tab drops its title at this width, so its count is a badge on the icon, fully inside the bar.
const withActivityCount = (count: number) =>
  BOT_PAGE_ITEMS.map((item) =>
    item.id === 'bot-activity' ? { ...item, count, countLabel: `${count} need you` } : item
  )

export const narrowestWithClosedCount = defineFixture({
  width: 260,
  render: () => <BotPageBar width={220} activeTab="bot-connectors" items={withActivityCount(3)} />
})

export const narrowestWithClosedTwoDigitCount = defineFixture({
  width: 260,
  render: () => <BotPageBar width={220} activeTab="bot-connectors" items={withActivityCount(12)} />
})

// Runs the bot page's real filter over an installed plugin panel, as the sidebar does.
const BOT_PAGE_ITEMS_WITH_PLUGIN = getVisibleRightSidebarActivityItems(
  [
    ...BOT_PAGE_ITEMS,
    ...getPluginPanelActivityItems([
      {
        id: 'panel',
        title: 'Notes',
        icon: 'book',
        tabKey: 'plugin:samples.notes/panel',
        pluginKey: 'samples.notes',
        pluginName: 'Notes'
      }
    ]).map((item) => ({ ...item, labeledTab: true }))
  ],
  { isFolder: true, isFolderWorkspace: true, hasSshHost: false, isBot: true }
)

export const withPluginPanel = defineFixture({
  width: 440,
  render: () => (
    <BotPageBar width={400} activeTab="bot-activity" items={BOT_PAGE_ITEMS_WITH_PLUGIN} />
  )
})

export const pluginPanelOpen = defineFixture({
  width: 440,
  render: () => (
    <BotPageBar
      width={400}
      activeTab="plugin:samples.notes/panel"
      items={BOT_PAGE_ITEMS_WITH_PLUGIN}
    />
  )
})

export const narrowWithPluginPanel = defineFixture({
  width: 260,
  render: () => (
    <BotPageBar width={220} activeTab="bot-activity" items={BOT_PAGE_ITEMS_WITH_PLUGIN} />
  )
})

// The default 350px right sidebar: only the plugin tab drops its title.
export const defaultWidthWithPluginPanel = defineFixture({
  width: 390,
  render: () => (
    <BotPageBar width={350} activeTab="bot-activity" items={BOT_PAGE_ITEMS_WITH_PLUGIN} />
  )
})

// With an Activity count there is less room, so Files drops its title after the plugin's.
export const defaultWidthWithPluginPanelAndCount = defineFixture({
  width: 390,
  render: () => (
    <BotPageBar
      width={350}
      activeTab="bot-activity"
      items={BOT_PAGE_ITEMS_WITH_PLUGIN.map((item) =>
        item.id === 'bot-activity' ? { ...item, count: 2, countLabel: '2 need you' } : item
      )}
    />
  )
})

// Seven plugin panels at the default width, with the last one opened from More: it keeps its title
// and the closed tabs that no longer fit move under More.
const BOT_PAGE_ITEMS_WITH_SEVEN_PLUGINS = getVisibleRightSidebarActivityItems(
  [
    ...BOT_PAGE_ITEMS,
    ...getPluginPanelActivityItems(
      Array.from({ length: 7 }, (_, index) => ({
        id: `panel${index}`,
        title: `Notes ${index}`,
        icon: 'book',
        tabKey: `plugin:samples.notes/panel${index}` as const,
        pluginKey: 'samples.notes',
        pluginName: 'Notes'
      }))
    ).map((item) => ({ ...item, labeledTab: true }))
  ],
  { isFolder: true, isFolderWorkspace: true, hasSshHost: false, isBot: true }
)

export const pluginPanelOpenFromMore = defineFixture({
  width: 390,
  render: () => (
    <BotPageBar
      width={350}
      activeTab="plugin:samples.notes/panel6"
      items={BOT_PAGE_ITEMS_WITH_SEVEN_PLUGINS}
    />
  )
})

// One-character plugin titles opened from More at the 237px and narrowest 220px sidebars: closed tabs
// move under More so the open title stays readable beside More.
const botPageItemsWithSevenPlugins = (lastTitle: string) =>
  BOT_PAGE_ITEMS_WITH_SEVEN_PLUGINS.map((item) =>
    item.id === 'plugin:samples.notes/panel6' ? { ...item, title: lastTitle } : item
  )

async function openLastFromMore(frame: HTMLElement): Promise<void> {
  frame
    .querySelector('[data-slot="dropdown-menu-trigger"]')
    ?.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 }))
  for (let tries = 0; tries < 60; tries++) {
    const last = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].at(-1)
    if (last) {
      last.click()
      return
    }
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
}

export const oneCharacterTitleOpenFromMore = defineFixture({
  width: 277,
  render: () => (
    <BotPageBar width={237} activeTab="bot-activity" items={botPageItemsWithSevenPlugins('W')} />
  ),
  interact: openLastFromMore
})

export const oneCharacterTitleOpenFromMoreNarrowest = defineFixture({
  width: 260,
  render: () => (
    <BotPageBar width={220} activeTab="bot-activity" items={botPageItemsWithSevenPlugins('中')} />
  ),
  interact: openLastFromMore
})
