import { describe, expect, it } from 'vitest'
import { getTopActivityBarLayout } from './activity-bar/activity-bar-overflow'

const botTabs = [
  { id: 'bot-activity' as const, title: 'Activity', labeledTab: true },
  { id: 'bot-connectors' as const, title: 'Connectors', labeledTab: true },
  { id: 'explorer' as const, title: 'Files', labeledTab: true }
]
const notesTab = { id: 'plugin:samples.notes/panel' as const, title: 'Notes', labeledTab: true }
const botTabsWithPlugin = [...botTabs, notesTab]
const ids = (items: { id: string }[]): string[] => items.map((item) => item.id)
const compactIds = (layout: { compactIds: ReadonlySet<string> }): string[] =>
  [...layout.compactIds].sort()

// The strip a bot's page gets at the default 350px right sidebar.
const DEFAULT_STRIP_WIDTH = 306

describe("a bot page's labeled tabs", () => {
  const fourTabs = [
    botTabs[0],
    botTabs[1],
    { id: 'bot-chats' as const, title: 'Chats', labeledTab: true },
    botTabs[2]
  ]

  it('keep every title when they fit', () => {
    const layout = getTopActivityBarLayout(fourTabs, 356, 'bot-connectors')
    expect(compactIds(layout)).toEqual([])
    expect(ids(layout.overflowItems)).toEqual([])
  })

  it('keep only the open title once they all no longer fit, never dropping titles one at a time', () => {
    const layout = getTopActivityBarLayout(fourTabs, DEFAULT_STRIP_WIDTH, 'bot-chats')
    expect(compactIds(layout)).toEqual(['bot-activity', 'bot-connectors', 'explorer'])
    expect(ids(layout.visibleItems)).toEqual([
      'bot-activity',
      'bot-connectors',
      'bot-chats',
      'explorer'
    ])
  })

  it('fit by the measured titles, not the estimate', () => {
    const layout = getTopActivityBarLayout(fourTabs, DEFAULT_STRIP_WIDTH, 'bot-chats', 0, () => 30)
    expect(compactIds(layout)).toEqual([])
  })

  it('hold the strip padding when every title shows', () => {
    expect(compactIds(getTopActivityBarLayout(fourTabs, 276, 'bot-chats', 8, () => 30))).toEqual([
      'bot-activity',
      'bot-connectors',
      'explorer'
    ])
  })

  it('drop the closed titles before hiding any tab, at the narrowest panel', () => {
    const layout = getTopActivityBarLayout(botTabs, 176, 'bot-connectors')
    expect(compactIds(layout)).toEqual(['bot-activity', 'explorer'])
    expect(ids(layout.visibleItems)).toEqual(['bot-activity', 'bot-connectors', 'explorer'])
  })

  it('keep the open tab titled even when it is the last one', () => {
    const layout = getTopActivityBarLayout(botTabsWithPlugin, DEFAULT_STRIP_WIDTH, notesTab.id)
    expect(layout.compactIds.has(notesTab.id)).toBe(false)
    expect(compactIds(layout)).toEqual(['bot-activity', 'bot-connectors', 'explorer'])
  })
})

describe('a labeled tab opened from More', () => {
  const pluginTabs = Array.from({ length: 7 }, (_, index) => ({
    id: `plugin:samples.notes/panel${index}` as const,
    title: `Notes ${index}`,
    labeledTab: true
  }))
  const crowded = [...botTabs, ...pluginTabs]
  const notes6 = pluginTabs[6].id
  const short = (items: { id: string }[]): string[] =>
    ids(items).map((id) => id.replace('plugin:samples.notes/', ''))
  const withNotes6 = (change: Partial<(typeof pluginTabs)[number]> & { count?: number }) =>
    crowded.map((item) => (item.id === notes6 ? { ...item, ...change } : item))

  it('keeps its title by moving closed tabs under More, not by squeezing the title away', () => {
    const layout = getTopActivityBarLayout(crowded, DEFAULT_STRIP_WIDTH, notes6)
    expect(layout.compactIds.has(notes6)).toBe(false)
    expect(short(layout.visibleItems)).toEqual([
      'bot-activity',
      'bot-connectors',
      'explorer',
      'panel0',
      'panel1',
      'panel2',
      'panel6'
    ])
    expect(short(layout.overflowItems)).toEqual(['panel3', 'panel4', 'panel5'])
  })

  it('gets the closed tabs back as the panel widens, and stays in the bar as it narrows', () => {
    expect(ids(getTopActivityBarLayout(crowded, 400, notes6).overflowItems)).toEqual([])
    expect(short(getTopActivityBarLayout(crowded, 176, notes6).visibleItems)).toEqual([
      'bot-activity',
      'panel6'
    ])
    const tooNarrow = getTopActivityBarLayout(crowded, 100, notes6)
    expect(short(tooNarrow.visibleItems)).toEqual(['panel6'])
    expect(tooNarrow.compactIds.has(notes6)).toBe(false)
  })

  it('makes room for a count or a longer title on it', () => {
    expect(
      short(
        getTopActivityBarLayout(withNotes6({ count: 3 }), DEFAULT_STRIP_WIDTH, notes6).visibleItems
      )
    ).toEqual(['bot-activity', 'bot-connectors', 'explorer', 'panel0', 'panel1', 'panel6'])
    expect(
      short(
        getTopActivityBarLayout(
          withNotes6({ title: 'Meeting notes 6' }),
          DEFAULT_STRIP_WIDTH,
          notes6
        ).visibleItems
      )
    ).toEqual(['bot-activity', 'bot-connectors', 'explorer', 'panel0', 'panel6'])
  })

  // The strips at the 237px and narrowest 220px right sidebars, which include an 8px left padding.
  const STRIP_PADDING = 8
  const one = (title: string) => withNotes6({ title })

  it('keeps a one-character title readable once every closed tab is an icon', () => {
    for (const title of ['W', '中']) {
      const crowdedLayout = getTopActivityBarLayout(one(title), 197, notes6, STRIP_PADDING)
      expect(short(crowdedLayout.visibleItems)).toEqual([
        'bot-activity',
        'bot-connectors',
        'explorer',
        'panel6'
      ])
      expect(crowdedLayout.compactIds.has(notes6)).toBe(false)
      // Few enough tabs to fit as icons by the estimate alone, yet not with a readable title.
      const fewer = one(title).filter((item) => !/panel[2-5]$/.test(item.id))
      expect(
        short(getTopActivityBarLayout(fewer, 197, notes6, STRIP_PADDING).overflowItems)
      ).toEqual(['panel0', 'panel1'])
      expect(
        short(getTopActivityBarLayout(one(title), 180, notes6, STRIP_PADDING).visibleItems)
      ).toEqual(['bot-activity', 'bot-connectors', 'panel6'])
    }
  })
})

describe("a regular workspace's icon tabs", () => {
  const iconTabs = [
    { id: 'explorer' as const, title: 'Explorer' },
    { id: 'ports' as const, title: 'Ports' },
    { id: 'source-control' as const, title: 'Source Control' },
    { id: 'checks' as const, title: 'Checks' }
  ]

  it('never compact and still overflow into More from the end', () => {
    expect(getTopActivityBarLayout(iconTabs, 144, 'explorer')).toEqual({
      visibleItems: iconTabs,
      overflowItems: [],
      compactIds: new Set()
    })
    const layout = getTopActivityBarLayout(iconTabs, 110, 'explorer')
    expect(compactIds(layout)).toEqual([])
    expect(ids(layout.visibleItems)).toEqual(['explorer', 'ports'])
    expect(ids(layout.overflowItems)).toEqual(['source-control', 'checks'])
  })
})
