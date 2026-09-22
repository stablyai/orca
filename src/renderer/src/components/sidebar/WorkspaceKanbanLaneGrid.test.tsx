// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import React, { createRef } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Repo } from '../../../../shared/repo-types'
import type { WorkspaceStatusDefinition, Worktree } from '../../../../shared/worktree/types'

const virtualWindow = vi.hoisted(() => ({ startIndex: 0, visibleCount: 4 }))
const animationFrames = new Map<number, FrameRequestCallback>()
let nextAnimationFrameId = 1

vi.mock('@tanstack/react-virtual', () => {
  const defaultRangeExtractor = (range: {
    startIndex: number
    endIndex: number
    overscan: number
    count: number
  }): number[] => {
    const start = Math.max(0, range.startIndex - range.overscan)
    const end = Math.min(range.count - 1, range.endIndex + range.overscan)
    return Array.from({ length: Math.max(0, end - start + 1) }, (_, index) => start + index)
  }
  return {
    defaultRangeExtractor,
    useVirtualizer: (options: {
      count: number
      estimateSize: (index: number) => number
      getItemKey: (index: number) => string | number
      gap: number
      rangeExtractor: (range: {
        startIndex: number
        endIndex: number
        overscan: number
        count: number
      }) => number[]
    }) => {
      const endIndex = Math.min(
        options.count - 1,
        virtualWindow.startIndex + virtualWindow.visibleCount - 1
      )
      const indexes =
        options.count === 0
          ? []
          : options.rangeExtractor({
              startIndex: virtualWindow.startIndex,
              endIndex,
              overscan: 1,
              count: options.count
            })
      const size = options.estimateSize(0)
      return {
        getTotalSize: () => Math.max(0, options.count * size + (options.count - 1) * options.gap),
        getVirtualItems: () =>
          indexes.map((index) => ({
            index,
            key: options.getItemKey(index),
            start: index * (size + options.gap)
          })),
        measureElement: () => {},
        measure: () => {}
      }
    }
  }
})

vi.mock('./WorkspaceKanbanStatusLane', () => ({
  default: ({
    status,
    items,
    renderCards,
    activeWorktreeIdentity
  }: {
    status: WorkspaceStatusDefinition
    items: readonly Worktree[]
    renderCards: boolean
    activeWorktreeIdentity: string | null
  }) => (
    <section
      data-workspace-status={status.id}
      data-item-count={items.length}
      data-render-cards={renderCards ? 'true' : 'false'}
      data-active-worktree-identity={activeWorktreeIdentity ?? ''}
    >
      <button type="button">{status.label}</button>
    </section>
  )
}))

const { default: WorkspaceKanbanLaneGrid } = await import('./WorkspaceKanbanLaneGrid')
const { extractWorkspaceKanbanLaneRange } = await import('./workspace-kanban-lane-range')

const STATUSES = Array.from({ length: 21 }, (_, index) => ({
  id: `state-${String(index + 1).padStart(2, '0')}`,
  label: `State ${index + 1}`
}))
const REPO_MAP = new Map<string, Repo>()

function makeGrid(activeWorktreeIdentity: string | null = null): React.JSX.Element {
  return (
    <WorkspaceKanbanLaneGrid
      laneScrollerRef={createRef()}
      statuses={STATUSES}
      laneViews={new Map()}
      laneFullWorktreeIds={new Map()}
      hasQuery={false}
      repoMap={REPO_MAP}
      activeWorktreeIdentity={activeWorktreeIdentity}
      columnWidth={308}
      isResizingColumn={false}
      dragOverStatus={null}
      renderCards={true}
      selectedWorktreeIds={new Set()}
      selectedWorktrees={[]}
      onDragOver={() => {}}
      onDragLeave={() => {}}
      onDrop={() => {}}
      onActivate={() => {}}
      onSelectionGesture={() => false}
      onContextMenuSelect={() => []}
      onCreateWorktree={() => {}}
      onColumnResizeStart={() => {}}
      onColumnResizeKeyDown={() => {}}
    />
  )
}

function renderGrid(): ReturnType<typeof render> {
  return render(makeGrid())
}

function mountedStatusIds(container: HTMLElement): string[] {
  return Array.from(container.querySelectorAll<HTMLElement>('[data-workspace-status]')).map(
    (lane) => lane.dataset.workspaceStatus ?? ''
  )
}

function flushNextAnimationFrame(): void {
  const next = animationFrames.entries().next().value as [number, FrameRequestCallback] | undefined
  expect(next).toBeDefined()
  if (!next) {
    return
  }
  animationFrames.delete(next[0])
  act(() => next[1](performance.now()))
}

beforeEach(() => {
  animationFrames.clear()
  nextAnimationFrameId = 1
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
    const id = nextAnimationFrameId
    nextAnimationFrameId += 1
    animationFrames.set(id, callback)
    return id
  })
  vi.spyOn(window, 'cancelAnimationFrame').mockImplementation((id) => {
    animationFrames.delete(id)
  })
})

afterEach(() => {
  virtualWindow.startIndex = 0
  cleanup()
  vi.restoreAllMocks()
})

describe('WorkspaceKanbanLaneGrid', () => {
  it('reserves the full workflow width while mounting only the horizontal window', () => {
    const { container } = renderGrid()

    expect(mountedStatusIds(container)).toEqual([
      'state-01',
      'state-02',
      'state-03',
      'state-04',
      'state-05'
    ])
    expect(
      container.querySelector<HTMLElement>('[data-workspace-board-lane-grid]')?.style.width
    ).toBe(`${21 * 308 + 20 * 12}px`)
  })

  it('mounts later ordered lanes and releases distant lanes after horizontal scroll', () => {
    const rendered = renderGrid()
    virtualWindow.startIndex = 17
    rendered.rerender(makeGrid())

    expect(mountedStatusIds(rendered.container)).toEqual([
      'state-17',
      'state-18',
      'state-19',
      'state-20',
      'state-21'
    ])
    expect(rendered.container.querySelector('[data-workspace-status="state-01"]')).toBeNull()
  })

  it('keeps one focused lane mounted without unbounding the virtual window', () => {
    const rendered = renderGrid()
    fireEvent.focus(rendered.getByRole('button', { name: 'State 1' }))

    virtualWindow.startIndex = 17
    rendered.rerender(makeGrid())

    expect(mountedStatusIds(rendered.container)).toEqual([
      'state-01',
      'state-17',
      'state-18',
      'state-19',
      'state-20',
      'state-21'
    ])
  })

  it('adds only the focused lane to the normal overscanned range', () => {
    expect(
      extractWorkspaceKanbanLaneRange({ startIndex: 4, endIndex: 7, overscan: 1, count: 21 }, 18)
    ).toEqual([3, 4, 5, 6, 7, 8, 18])
  })

  it('hydrates at most one mounted lane per animation frame', () => {
    const { container } = renderGrid()
    const renderedLaneCount = (): number =>
      container.querySelectorAll('[data-render-cards="true"]').length

    expect(renderedLaneCount()).toBe(0)
    flushNextAnimationFrame()
    expect(renderedLaneCount()).toBe(1)
    flushNextAnimationFrame()
    expect(renderedLaneCount()).toBe(2)
  })

  it('passes the host-qualified active workspace through virtualized lanes', () => {
    const { container } = render(makeGrid('ssh:builder|repo::/workspace'))

    expect(
      container.querySelector<HTMLElement>('[data-workspace-status]')?.dataset
        .activeWorktreeIdentity
    ).toBe('ssh:builder|repo::/workspace')
  })
})
