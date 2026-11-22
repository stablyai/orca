// @vitest-environment happy-dom
// Perf contract (#45971, bot Home panel items list): a shown group mounted every row (900 rows for 10 visible
// at 600 open items), and every item update re-rendered every mounted row. Rows mounted stay near what
// the panel shows, and one changed item re-renders one row.
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { useMemo, useRef } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import type { Bot } from '../../../../../shared/bot-types'
import type { BotItem } from '../../../../../shared/bots/bot-items'
import { groupBotItems } from '../../../../../shared/bots/bot-item-groups'
import { makeTestBotItem } from '../../../../../shared/bots/bot-item.test-fixture'
import { reuseEqualJson } from '../../../../../shared/reuse-equal-json'

// Each row works out its age line once per render of its item; the activity time names the row.
const rowRenders = vi.hoisted((): { at: number[] } => ({ at: [] }))

vi.mock('./use-bot-items', () => ({ setBotItemsStatus: vi.fn() }))
vi.mock('@/lib/time-format/short-time-ago', async (importOriginal) => {
  const actual = await importOriginal<{
    formatShortTimeAgo: (ts: number, now?: number) => string
  }>()
  return {
    ...actual,
    formatShortTimeAgo: (ts: number, now?: number) => {
      rowRenders.at.push(ts)
      return actual.formatShortTimeAgo(ts, now)
    }
  }
})

import { BotItemsList } from './BotItemsList'

const BOT: Bot = {
  id: 'bot-a',
  name: 'Bot builder',
  hostId: 'local',
  folder: 'bot-builder',
  folderWorkspaceId: 'w1',
  agent: 'codex',
  avatar: null,
  paused: false,
  permissionMode: 'ask',
  notifications: { needsPermission: true, taskComplete: true, couldNotFinish: true },
  members: [],
  slack: null,
  chatSessionId: null,
  linear: null,
  github: null,
  createdAt: 1,
  updatedAt: 1
}
const NOW = Date.parse('2026-11-20T12:00:00Z')
const OPEN = 600
const ROW_PX = 30
const PANEL_PX = 400

function Panel({
  items,
  allClear = false
}: {
  items: readonly BotItem[]
  allClear?: boolean
}): React.JSX.Element {
  const scroller = useRef<HTMLDivElement | null>(null)
  const groups = useMemo(() => groupBotItems(items, null, NOW, 'e10'), [items])
  return (
    <div
      ref={scroller}
      data-testid="scroller"
      data-bot-items-scroller=""
      style={{ height: PANEL_PX, overflowY: 'auto' }}
    >
      <BotItemsList
        allClear={allClear ? <div role="status" /> : null}
        bot={BOT}
        groups={groups}
        seenEventId="e10"
        closedTotal={0}
        onMoreClosed={null}
        staleDays={null}
        now={NOW}
        onOpen={() => {}}
        scroller={scroller}
      />
    </div>
  )
}

/** The host's answer as the read gets it: fresh objects, newest activity first. */
function hostAnswer(changed: { number: number; title: string } | null, count = OPEN): BotItem[] {
  const items = Array.from({ length: count }, (_, index) =>
    makeTestBotItem(index + 1, { status: 'planned', lastActivityAt: NOW - (index + 1) * 1000 })
  )
  if (changed) {
    const item = items[changed.number - 1]!
    items[changed.number - 1] = { ...item, title: changed.title, lastActivityAt: NOW }
  }
  // The host lists newest activity first, so the changed item moves to the top of the answer.
  items.sort((a, b) => b.lastActivityAt - a.lastActivityAt)
  const answer: BotItem[] = JSON.parse(JSON.stringify(items))
  return answer
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(NOW)
  // The panel's scroller shows 400 px from the top of the list.
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
    this: HTMLElement
  ) {
    return this.dataset.testid === 'scroller'
      ? new DOMRect(0, 0, 320, PANEL_PX)
      : new DOMRect(0, 0, 320, ROW_PX)
  })
})

afterEach(() => {
  cleanup()
  localStorage.clear()
  rowRenders.at = []
  vi.restoreAllMocks()
  vi.useRealTimers()
})

async function showWholePlannedGroup(items: readonly BotItem[]) {
  const view = render(<Panel items={items} />, { wrapper: TooltipProvider })
  fireEvent.click(screen.getByRole('button', { name: /^Planned/ }))
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: `Show ${items.length - 5} more` }))
  })
  return view
}

it('mounts about what the panel shows of a 600-row group, not every row', async () => {
  await showWholePlannedGroup(hostAnswer(null))
  const mounted = document.querySelectorAll('[data-bot-item]').length
  // 400 px of 30 px rows, plus the window's overscan on each side.
  expect(mounted).toBeGreaterThan(0)
  expect(mounted).toBeLessThanOrEqual(40)
})

// A long group renders windowed, a short one in full: both keep each row on its item. A long group's one
// Tab stop is its first row until a row is focused, so the row it passes from renders too.
it.each([
  { count: OPEN, changed: 300, renders: [NOW, NOW - 1000] },
  { count: 20, changed: 15, renders: [NOW] }
])(
  're-renders only the changed row when an update moves it to the top ($count rows)',
  async ({ count, changed, renders }) => {
    const first = hostAnswer(null, count)
    const view = await showWholePlannedGroup(first)
    rowRenders.at = []
    // The item gets a comment: the host's next answer is all-new objects, and it now sorts first.
    const next = reuseEqualJson(first, hostAnswer({ number: changed, title: 'Updated' }, count))
    view.rerender(<Panel items={next} />)
    // Only the changed item, whose activity is now, renders (and the row that was first, a second ago).
    expect(rowRenders.at).toEqual(renders)
  }
)

it('keeps the expanded window aligned as the all-clear appears and disappears', async () => {
  vi.mocked(HTMLElement.prototype.getBoundingClientRect).mockImplementation(function (
    this: HTMLElement
  ) {
    if (this.getAttribute('role') === 'grid') {
      const top = document.querySelector('[role=status]') ? 120 : 0
      return new DOMRect(0, top, 320, OPEN * ROW_PX)
    }
    return new DOMRect(0, 0, 320, this.dataset.testid === 'scroller' ? PANEL_PX : ROW_PX)
  })
  const items = hostAnswer(null)
  const view = await showWholePlannedGroup(items)
  const grid = screen.getByRole('grid')
  const lastRow = () =>
    Number(
      Array.from(grid.querySelectorAll('[aria-rowindex]')).at(-1)?.getAttribute('aria-rowindex')
    )
  const initialEnd = lastRow()

  await act(async () => view.rerender(<Panel items={items} allClear />))
  expect(initialEnd - lastRow()).toBe(4)

  await act(async () => view.rerender(<Panel items={items} />))
  expect(lastRow()).toBe(initialEnd)
})
