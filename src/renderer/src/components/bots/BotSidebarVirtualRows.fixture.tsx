import { useRef, useState } from 'react'
import { flushSync } from 'react-dom'
import { cn } from '@/lib/class-names'
import { defineFixture } from '../../component-fixtures/component-fixture'
import { BotSidebarVirtualRows } from './BotSidebarVirtualRows'
import { revealBotSidebarRow } from './reveal-bot-sidebar-row'

const ROW_HEIGHT = 48

// Simulated bots: each row's height stands in for its nested chat lines.
function Rows({
  count,
  initialHeights,
  mountWithList = false
}: {
  count: number
  initialHeights: Record<string, number>
  mountWithList?: boolean
}): React.JSX.Element {
  const listRef = useRef<HTMLDivElement | null>(null)
  const [entries] = useState(() =>
    Array.from({ length: count }, (_, index) => ({ id: `bot-${index}`, name: `Bot ${index}` }))
  )
  const [heights, setHeights] = useState(initialHeights)
  const [hidden, setHidden] = useState(false)
  // Rows mount once the list has, as when the sidebar's bots load after it.
  const [listMounted, setListMounted] = useState(mountWithList)
  const setHeight = (id: string, height: number): void =>
    setHeights((current) => ({ ...current, [id]: height }))
  // Like the sidebar search: show the list in one commit, then reveal at once.
  const showAndReveal = (sidebarKey: string): void => {
    flushSync(() => setHidden(false))
    revealBotSidebarRow({
      sidebarKey,
      isCurrent: () => true,
      focusName: true,
      defer: false,
      getList: () => listRef.current
    })
  }
  return (
    <div className="flex flex-col gap-2 p-2">
      <div className="flex flex-wrap gap-2">
        <button type="button" onClick={() => setHidden(true)}>
          Hide list
        </button>
        <button type="button" onClick={() => setHeight('bot-0', ROW_HEIGHT)}>
          Shrink Bot 0
        </button>
        <button type="button" onClick={() => setHeight('bot-0', ROW_HEIGHT + 1600)}>
          Grow Bot 0
        </button>
        <button type="button" onClick={() => setHeight('bot-1', ROW_HEIGHT + 32)}>
          Add a chat line to Bot 1
        </button>
        {[entries[400], entries.at(-1)].map((entry) =>
          entry ? (
            <button key={entry.id} type="button" onClick={() => showAndReveal(entry.id)}>
              Show list and reveal {entry.name}
            </button>
          ) : null
        )}
      </div>
      <div className={cn(hidden && 'hidden')}>
        <div
          ref={(node) => {
            listRef.current = node
            if (!mountWithList) {
              setListMounted(node !== null)
            }
          }}
          data-bot-sidebar-list=""
          className="bot-sidebar-scrollbar h-[400px] overflow-y-auto [overflow-anchor:none]"
        >
          {listMounted ? (
            <BotSidebarVirtualRows
              entries={entries}
              draggingId={null}
              revealId={undefined}
              renderEntry={(entry) => (
                <div
                  data-bot-sidebar-entry={entry.id}
                  className="border-b border-border"
                  style={{ height: heights[entry.id] ?? ROW_HEIGHT }}
                >
                  <button type="button" data-worktree-title-inline-rename="">
                    {entry.name}
                  </button>
                </div>
              )}
            />
          ) : null}
        </div>
      </div>
    </div>
  )
}

// Bot 0 starts unfolded; it shrinks while search hides the list, then a result is picked.
export const revealAfterHiddenShrink = defineFixture({
  width: 320,
  render: () => <Rows count={750} initialHeights={{ 'bot-0': 848 }} />
})

// A bot gains a chat line after its first measure.
export const growingRow = defineFixture({
  width: 320,
  render: () => <Rows count={20} initialHeights={{}} />
})

// Reopening the sidebar mounts the list and its rows in one commit, all at the estimated height.
export const mountedWithList = defineFixture({
  width: 320,
  render: () => <Rows count={10} initialHeights={{}} mountWithList />
})
