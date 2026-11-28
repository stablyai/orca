// @vitest-environment happy-dom
import { act, cleanup, render } from '@testing-library/react'
import { useLayoutEffect, useRef } from 'react'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { useAppStore } from '@/store'
import type { Tab } from '../../../../../../shared/workspace-layout/tab-groups/tab-types'
import {
  NativeChatViewTabContext,
  releaseNativeChatViewTabs
} from '../../pane/ownership/native-chat-view-memory'
import {
  useNativeChatFindMatches,
  type NativeChatFindMatches
} from './use-native-chat-find-matches'

const TAB = { tabId: 'tab-1', worktreeId: 'wt-1', conversation: 'claude:s1' }

function Transcript({
  restoredQuery,
  report,
  rows
}: {
  restoredQuery: string | null
  report: (find: NativeChatFindMatches) => void
  rows: readonly string[]
}) {
  const rootRef = useRef<HTMLDivElement>(null)
  const barRef = useRef<HTMLElement>(null)
  const find = useNativeChatFindMatches({
    rootRef,
    barRef,
    query: 'cat',
    isVisible: true,
    revealMatch: () => {},
    restoredQuery
  })
  useLayoutEffect(() => {
    report(find)
  })
  return (
    <div ref={rootRef}>
      <div data-native-chat-transcript-column="">
        {rows.map((row) => (
          <div key={row} data-native-chat-row-key={row}>
            cat cat
          </div>
        ))}
      </div>
    </div>
  )
}

function mount(
  restoredQuery: string | null,
  rows: readonly string[] = ['m1', 'm2']
): {
  find: () => NativeChatFindMatches
  draw: (rows: readonly string[]) => void
  unmount: () => void
} {
  let latest: NativeChatFindMatches | null = null
  const at = (drawn: readonly string[]) => (
    <NativeChatViewTabContext value={TAB}>
      <Transcript restoredQuery={restoredQuery} report={(find) => (latest = find)} rows={drawn} />
    </NativeChatViewTabContext>
  )
  const view = render(at(rows))
  return {
    find: () => {
      if (!latest) {
        throw new Error('not rendered')
      }
      return latest
    },
    draw: (drawn) => view.rerender(at(drawn)),
    unmount: view.unmount
  }
}

beforeEach(() => {
  useAppStore.setState({
    unifiedTabsByWorktree: {
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: these checks read only a tab's id.
      [TAB.worktreeId]: [{ id: TAB.tabId } as Tab]
    }
  })
})
afterEach(() => {
  cleanup()
  releaseNativeChatViewTabs([TAB.tabId])
})

it('a chat switched back to keeps the match Find had selected', () => {
  const first = mount(null)
  expect(first.find().matchCount).toBe(4)
  act(() => first.find().step(1))
  act(() => first.find().step(1))
  expect(first.find().activeIndex).toBe(2)
  first.unmount()
  const back = mount('cat')
  expect(back.find().activeIndex).toBe(2)
})

it("a chat whose kept match's row draws after the first search still lands on that match", async () => {
  const first = mount(null)
  act(() => first.find().step(1))
  expect(first.find().activeIndex).toBe(1)
  first.unmount()
  // Back with only the newest row drawn, as a remount starts at the end.
  const back = mount('cat', ['m2'])
  expect(back.find().activeIndex).toBe(0)
  await act(async () => {
    back.draw(['m1', 'm2'])
    await new Promise((resolve) => requestAnimationFrame(resolve))
  })
  expect(back.find().activeIndex).toBe(1)
})
