// @vitest-environment happy-dom
// Layout (no overlap when a row grows, reveal after a hidden resize) is covered in real Chromium by
// tests/component-fixtures/bot-sidebar-virtual-rows.spec.ts.
import { cleanup, render } from '@testing-library/react'
import { useRef } from 'react'
import { afterEach, describe, expect, it } from 'vitest'
import { BotSidebarVirtualRows, flowSpacers } from './BotSidebarVirtualRows'

afterEach(cleanup)

type Entry = { id: string; name: string }

function List({ entries }: { entries: Entry[] }): React.JSX.Element {
  const listRef = useRef<HTMLDivElement | null>(null)
  return (
    <div ref={listRef} data-bot-sidebar-list="" style={{ height: 300, overflowY: 'auto' }}>
      <BotSidebarVirtualRows
        entries={entries}
        listRef={listRef}
        draggingId={null}
        revealId={undefined}
        renderEntry={(entry) => <div data-entry={entry.id}>{entry.name}</div>}
      />
    </div>
  )
}

const entries = (count: number): Entry[] =>
  Array.from({ length: count }, (_, index) => ({ id: `bot-${index}`, name: `Bot ${index}` }))

describe('BotSidebarVirtualRows', () => {
  it('keeps each entry mounted when the rendered window shifts', () => {
    const { container, rerender } = render(<List entries={entries(3)} />)
    const second = container.querySelector('[data-entry="bot-1"]')
    rerender(<List entries={[{ id: 'bot-new', name: 'New bot' }, ...entries(3)]} />)
    expect(container.querySelector('[data-entry="bot-1"]')).toBe(second)
  })
})

describe('flowSpacers', () => {
  it('fills the rows before, between and after the rendered ones, pinned far rows included', () => {
    expect(
      flowSpacers(
        [
          { start: 96, end: 168 },
          { start: 168, end: 216 },
          { start: 480, end: 528 }
        ],
        600
      )
    ).toEqual({ gaps: [96, 0, 264], tail: 72 })
    expect(flowSpacers([], 120)).toEqual({ gaps: [], tail: 120 })
  })
})
