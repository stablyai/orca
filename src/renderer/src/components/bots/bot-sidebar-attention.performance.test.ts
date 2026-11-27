// Guards STA-18283 (follow-up to #48722): a bot list's folded-history attention re-reads only the
// workspaces a store write changed, so an agent status update outside the list reads none of them.
// STA-18521 / STA-18523: a browser navigation or a combined terminal title write elsewhere costs the
// reader nothing per other workspace, however many browser workspaces or tab buckets exist.
import { beforeEach, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import { makeTab } from '@/store/terminals/testing/terminal-tab.test-fixture'
import {
  buildBrowserPage,
  buildWorkspaceFromPage
} from '@/store/slices/browser/pages/browser-page-records'
import type { BrowserPage } from '../../../../shared/browser/workspaces/browser-workspace-types'
import type * as StatusModule from '@/components/sidebar/workspace-card/activity/use-worktree-activity-status'
import { createWatchedAttentionReader } from './bot-sidebar-attention'

let reads = 0

vi.mock(
  '@/components/sidebar/workspace-card/activity/use-worktree-activity-status',
  async (importOriginal) => {
    const actual = await importOriginal<typeof StatusModule>()
    return {
      ...actual,
      // Each workspace whose card status is read counts once.
      selectWorktreeActivityStatus: (
        ...args: Parameters<typeof actual.selectWorktreeActivityStatus>
      ) => {
        reads += 1
        return actual.selectWorktreeActivityStatus(...args)
      }
    }
  }
)

const WATCHED = Array.from({ length: 300 }, (_, index) => `wt-${index}`)

function report(worktreeId: string, state: 'working' | 'done', prompt: string): void {
  const tabId = `tab-${worktreeId}`
  useAppStore
    .getState()
    .setAgentStatus(`${tabId}:1`, { state, prompt, agentType: 'claude' }, 'Claude', undefined, {
      tabId,
      worktreeId
    })
}

beforeEach(() => {
  const ids = [...WATCHED, 'wt-elsewhere']
  useAppStore.setState({
    tabsByWorktree: Object.fromEntries(
      ids.map((id) => [id, [makeTab({ id: `tab-${id}`, worktreeId: id })]])
    )
  })
  report('wt-elsewhere', 'working', 'first')
  report('wt-7', 'done', 'first')
})

it('reads no watched workspace for a status update elsewhere or a redraw, and only the one that changed', () => {
  const read = createWatchedAttentionReader()
  expect(read(useAppStore.getState(), WATCHED)).toEqual([])

  reads = 0
  report('wt-elsewhere', 'working', 'second')
  expect(read(useAppStore.getState(), WATCHED)).toEqual([])
  expect(reads).toBe(0)

  report('wt-7', 'working', 'second')
  expect(read(useAppStore.getState(), WATCHED)).toEqual(['wt-7'])
  expect(reads).toBe(1)

  reads = 0
  report('wt-7', 'done', 'third')
  expect(read(useAppStore.getState(), WATCHED)).toEqual([])
  expect(reads).toBe(1)

  // A list redrawn with the same workspaces reads none of them again.
  reads = 0
  expect(read(useAppStore.getState(), [...WATCHED])).toEqual([])
  expect(reads).toBe(0)
})

const FLEET = 750

/** A copy of a plain record whose own entries count every read of their value. */
function counted<T extends object>(target: T, onRead: () => void): T {
  const copy: T = Object.create(Object.getPrototypeOf(target))
  for (const [key, value] of Object.entries(target)) {
    Object.defineProperty(copy, key, {
      enumerable: true,
      get: () => {
        onRead()
        return value
      }
    })
  }
  return copy
}

it('reads no other browser workspace when a page elsewhere navigates (STA-18521)', () => {
  const ids = Array.from({ length: FLEET }, (_, index) => `browser-wt-${index}`)
  const pages: Record<string, BrowserPage[]> = {}
  useAppStore.setState({
    browserPagesByWorkspace: pages,
    browserTabsByWorktree: Object.fromEntries(
      ids.map((id) => {
        const page = buildBrowserPage(`ws-${id}`, id, 'https://example.com', 'Example')
        pages[`ws-${id}`] = [page]
        return [id, [buildWorkspaceFromPage(`ws-${id}`, id, page, [page.id])]]
      })
    )
  })
  const read = createWatchedAttentionReader()
  const watched = WATCHED.slice(0, 5)
  let bucketReads = 0
  // Counts the reader's reads of the buckets it held before the next write.
  const arm = (): void => {
    useAppStore.setState({
      browserTabsByWorktree: counted(useAppStore.getState().browserTabsByWorktree, () => {
        bucketReads += 1
      })
    })
    read(useAppStore.getState(), watched)
  }
  const readAfter = (write: () => void): void => {
    arm()
    write()
    bucketReads = 0
    reads = 0
    read(useAppStore.getState(), watched)
  }

  const navigated = pages[`ws-${ids[FLEET - 1]}`]![0]!.id
  readAfter(() => useAppStore.getState().setBrowserPageUrl(navigated, 'https://example.com/next'))
  expect(bucketReads).toBe(0)
  expect(reads).toBe(0)

  // The load and title updates that follow a navigation are as cheap.
  readAfter(() =>
    useAppStore.getState().updateBrowserPageState(navigated, { loading: false, title: 'Next' })
  )
  expect(bucketReads).toBe(0)
  expect(reads).toBe(0)
})

it('reads no other tab bucket for a combined pane and tab title write (STA-18523)', () => {
  const ids = Array.from({ length: FLEET }, (_, index) => `title-wt-${index}`)
  let tabIdReads = 0
  const countTabIdReads = (): void => {
    tabIdReads += 1
  }
  useAppStore.setState({
    tabsByWorktree: Object.fromEntries(
      ids.map((id) => [
        id,
        [counted(makeTab({ id: `tab-${id}`, worktreeId: id }), countTabIdReads)]
      ])
    ),
    runtimePaneTitlesByTabId: {}
  })
  const read = createWatchedAttentionReader()
  const watched = [ids[0]!]
  read(useAppStore.getState(), watched)

  const titled = `tab-${ids[FLEET - 1]}`
  useAppStore.getState().setRuntimePaneTitle(titled, 1, 'build', { alsoTabTitle: true })
  expect(useAppStore.getState().runtimePaneTitlesByTabId[titled]).toEqual({ 1: 'build' })
  tabIdReads = 0
  reads = 0
  expect(read(useAppStore.getState(), watched)).toEqual([])
  expect(tabIdReads).toBe(0)
  expect(reads).toBe(0)

  // A title write in a watched workspace re-reads that workspace alone.
  useAppStore.getState().setRuntimePaneTitle(`tab-${ids[0]}`, 1, 'build', { alsoTabTitle: true })
  reads = 0
  read(useAppStore.getState(), watched)
  expect(reads).toBe(1)
})
