// @vitest-environment happy-dom
/**
 * Why a render test: the board's open cost was mounting every card in every
 * lane at once. These assert the lane renders only the virtual window, and that
 * each rendered card still advertises its true lane index — drop-index math
 * reads that attribute now that DOM order no longer implies list order.
 *
 * The virtualizer itself is mocked (as the sidebar list tests do): it needs real
 * layout, which the test DOM has none of, and the contract under test is ours.
 */
import { cleanup, render } from '@testing-library/react'
import { createRef } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Repo, Worktree } from '../../../../shared/types'

const WINDOW_START = 20
const WINDOW_END = 25
const TOTAL_SIZE = 21_992

vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: ({ count }: { count: number }) => {
    const start = count === 0 ? 0 : Math.min(WINDOW_START, count - 1)
    const end = count === 0 ? -1 : Math.min(WINDOW_END, count - 1)
    return {
      getTotalSize: () => (count === 0 ? 0 : count * 44 - 8),
      measurementsCache: Array.from({ length: count }, (_, index) => ({
        index,
        start: index * 44,
        end: index * 44 + 36
      })),
      getVirtualItems: () =>
        Array.from({ length: Math.max(0, end - start + 1) }, (_, offset) => {
          const index = start + offset
          return { index, key: `w${index}`, start: index * 44 }
        }),
      measureElement: () => {}
    }
  }
}))

vi.mock('./WorkspaceKanbanCard', () => ({
  default: ({ worktree, laneIndex }: { worktree: Worktree; laneIndex: number }) => (
    <div data-workspace-board-card-id={worktree.id} data-workspace-board-card-index={laneIndex} />
  )
}))

const { default: WorkspaceKanbanLaneCardList } = await import('./WorkspaceKanbanLaneCardList')

const REPO_MAP = new Map<string, Repo>()

function renderLane(count: number): HTMLElement {
  const scrollRef = createRef<HTMLDivElement>()
  const { container } = render(
    <div ref={scrollRef}>
      <WorkspaceKanbanLaneCardList
        items={Array.from({ length: count }, (_, index) => ({ id: `w${index}` }) as Worktree)}
        repoMap={REPO_MAP}
        activeWorktreeId={null}
        scrollRef={scrollRef}
        selectedWorktreeIds={new Set()}
        selectedWorktrees={[]}
        nativeDragEnabled={false}
        onActivate={() => {}}
        onSelectionGesture={() => false}
        onContextMenuSelect={() => []}
      />
    </div>
  )
  return container
}

afterEach(cleanup)

describe('WorkspaceKanbanLaneCardList', () => {
  it('mounts only the virtual window, not the whole lane', () => {
    const container = renderLane(500)

    const ids = Array.from(container.querySelectorAll('[data-workspace-board-card-id]')).map(
      (card) => card.getAttribute('data-workspace-board-card-id')
    )
    expect(ids).toEqual(['w20', 'w21', 'w22', 'w23', 'w24', 'w25'])
  })

  it('gives every rendered card its lane index, not its rendered position', () => {
    const container = renderLane(500)

    const indexes = Array.from(container.querySelectorAll('[data-workspace-board-card-index]')).map(
      (card) => Number(card.getAttribute('data-workspace-board-card-index'))
    )
    expect(indexes).toEqual([20, 21, 22, 23, 24, 25])
  })

  it('reserves the full lane height so the scrollbar spans the whole list', () => {
    const container = renderLane(500)

    const spacer = container.querySelector<HTMLElement>('[data-workspace-board-card-id]')
      ?.parentElement?.parentElement
    expect(spacer?.style.height).toBe(`${TOTAL_SIZE}px`)
  })

  it('positions each card at its virtual offset', () => {
    const container = renderLane(500)

    const first = container.querySelector<HTMLElement>(
      '[data-workspace-board-card-id]'
    )?.parentElement
    expect(first?.style.transform).toBe(`translateY(${WINDOW_START * 44}px)`)
  })

  it('renders nothing for an empty lane and a single card at index 0', () => {
    const empty = renderLane(0)
    expect(empty.querySelectorAll('[data-workspace-board-card-id]')).toHaveLength(0)

    const single = renderLane(1)
    const card = single.querySelector('[data-workspace-board-card-id]')
    expect(card?.getAttribute('data-workspace-board-card-id')).toBe('w0')
    expect(card?.getAttribute('data-workspace-board-card-index')).toBe('0')
  })
})
