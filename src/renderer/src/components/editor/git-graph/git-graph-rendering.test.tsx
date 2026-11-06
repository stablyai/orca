// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import { GitHistoryPanel } from '@/components/right-sidebar/source-control/sync/git-history-panel'
import { GitGraphFilter } from './git-graph-filter'
import { gitGraphFilterSupported } from './use-git-graph-history'
import type { GitHistoryResult } from '../../../../../shared/git/history/git-history-types'
import * as graph from '../../../../../shared/git/history/git-history-graph'

vi.mock('@/lib/git-graph-tab', () => ({ gitGraphScope: () => ({ target: { kind: 'local' } }) }))
vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: (options: { count: number }) => ({
    getTotalSize: () => options.count * 28,
    getVirtualItems: () =>
      Array.from({ length: options.count }, (_, index) => ({ index, start: index * 28 })),
    measureElement: () => {}
  })
}))
const container = document.createElement('div')
document.body.appendChild(container)
let root = createRoot(container)
afterEach(async () => {
  await act(async () => root.unmount())
  root = createRoot(container)
  vi.restoreAllMocks()
})
const result: GitHistoryResult = {
  items: [{ id: 'a', subject: 'subject', message: 'subject', parentIds: [] }],
  hasMore: false,
  hasIncomingChanges: false,
  hasOutgoingChanges: false,
  limit: 50
}

it('keeps view models on expand and resize, rebuilding when history changes', async () => {
  const build = vi.spyOn(graph, 'buildGitHistoryViewModels')
  const render = (history: GitHistoryResult) => (
    <TooltipProvider>
      <GitHistoryPanel
        state={{ status: 'ready', result: history }}
        collapsed={false}
        onToggle={() => {}}
        onRefresh={() => {}}
        onLoadCommitFiles={async () => []}
        onOpenCommitFile={() => {}}
      />
    </TooltipProvider>
  )
  await act(async () => root.render(render(result)))
  expect(build).toHaveBeenCalledTimes(1)
  await act(async () =>
    (container.querySelector('[data-testid="git-history-row"]') as HTMLButtonElement).click()
  )
  await act(async () =>
    container
      .querySelector('[role="separator"]')!
      .dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }))
  )
  expect(build).toHaveBeenCalledTimes(1)
  await act(async () =>
    root.render(
      render({
        ...result,
        items: [...result.items, { id: 'b', subject: 'next', message: 'next', parentIds: [] }]
      })
    )
  )
  expect(build).toHaveBeenCalledTimes(2)
  expect(
    container.querySelector('[data-testid="git-history-row"]')?.getAttribute('aria-expanded')
  ).toBe('true')
})

it('disables the branch filter when an older host omits the refs echo', async () => {
  await act(async () =>
    root.render(
      <TooltipProvider>
        <GitGraphFilter
          worktreeId="w"
          filter="all"
          supported={gitGraphFilterSupported(result)}
          onChange={() => {}}
        />
      </TooltipProvider>
    )
  )
  expect(container.querySelector('button')?.disabled).toBe(true)
  await act(async () =>
    root.render(
      <TooltipProvider>
        <GitGraphFilter
          worktreeId="w"
          filter="all"
          supported={gitGraphFilterSupported({ ...result, refs: 'all' })}
          onChange={() => {}}
        />
      </TooltipProvider>
    )
  )
  expect(container.querySelector('button')?.disabled).toBe(false)
})
