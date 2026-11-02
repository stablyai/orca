// @vitest-environment happy-dom
/** Mock layout-dependent virtualization; assert only the visible card window and true lane-index attributes. */
import { cleanup, render } from '@testing-library/react'
import { createRef } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Repo } from '../../../../shared/repo-types'
import type { Worktree } from '../../../../shared/worktree/types'
import { getWorktreeHostIdentity } from '../../../../shared/worktree/host-qualified-identity'
import { makeWorktree } from '../../store/slices/worktrees-slice-test-fixtures'

const WINDOW_START = 20
const WINDOW_END = 25
const virtualizerKeys = vi.hoisted(() => [] as (string | number)[])

vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: ({
    count,
    getItemKey
  }: {
    count: number
    getItemKey: (index: number) => string | number
  }) => {
    const start = count === 0 || count <= WINDOW_END + 1 ? 0 : WINDOW_START
    const end = count === 0 ? -1 : Math.min(WINDOW_END, count - 1)
    virtualizerKeys.splice(0)
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
          const key = getItemKey(index)
          virtualizerKeys.push(key)
          return { index, key, start: index * 44 }
        }),
      measureElement: () => {}
    }
  }
}))

vi.mock('./WorkspaceKanbanCard', () => ({
  default: ({
    worktree,
    laneIndex,
    isActive,
    isSelected
  }: {
    worktree: Worktree
    laneIndex: number
    isActive: boolean
    isSelected: boolean
  }) => (
    <div
      data-workspace-board-card-id={getWorktreeHostIdentity(worktree)}
      data-workspace-board-worktree-id={worktree.id}
      data-workspace-board-card-index={laneIndex}
      data-active={isActive ? 'true' : 'false'}
      data-selected={isSelected ? 'true' : 'false'}
    />
  )
}))

const { default: WorkspaceKanbanLaneCardList } = await import('./WorkspaceKanbanLaneCardList')

const REPO_MAP = new Map<string, Repo>()

function renderLaneItems(
  items: readonly Worktree[],
  options: { activeIdentity?: string; selectedIdentities?: readonly string[] } = {}
): HTMLElement {
  const scrollRef = createRef<HTMLDivElement>()
  const { container } = render(
    <div ref={scrollRef}>
      <WorkspaceKanbanLaneCardList
        items={items}
        repoMap={REPO_MAP}
        activeWorktreeIdentity={options.activeIdentity ?? null}
        scrollRef={scrollRef}
        selectedWorktreeIds={new Set(options.selectedIdentities)}
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
  it('gives same-id cards unique host-qualified virtual and DOM identities', () => {
    const container = renderLaneItems(
      [
        makeWorktree({ id: 'shared', repoId: 'repo', hostId: 'local' }),
        makeWorktree({ id: 'shared', repoId: 'repo', hostId: 'ssh:host-b' })
      ],
      {
        activeIdentity: 'ssh:host-b|shared',
        selectedIdentities: ['local|shared']
      }
    )

    expect(virtualizerKeys).toEqual(['local|shared', 'ssh:host-b|shared'])
    expect(
      Array.from(container.querySelectorAll('[data-workspace-board-card-id]')).map((card) =>
        card.getAttribute('data-workspace-board-card-id')
      )
    ).toEqual(['local|shared', 'ssh:host-b|shared'])
    expect(
      Array.from(container.querySelectorAll('[data-workspace-board-card-id]')).map((card) => ({
        active: card.getAttribute('data-active'),
        selected: card.getAttribute('data-selected')
      }))
    ).toEqual([
      { active: 'false', selected: 'true' },
      { active: 'true', selected: 'false' }
    ])
  })
})
