// @vitest-environment happy-dom
import { act, cleanup, render } from '@testing-library/react'
import { useRef } from 'react'
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
  report
}: {
  restoredQuery: string | null
  report: (find: NativeChatFindMatches) => void
}) {
  const rootRef = useRef<HTMLDivElement>(null)
  const barRef = useRef<HTMLElement>(null)
  report(
    useNativeChatFindMatches({
      rootRef,
      barRef,
      query: 'cat',
      isVisible: true,
      revealMatch: () => {},
      restoredQuery
    })
  )
  return (
    <div ref={rootRef}>
      <div data-native-chat-transcript-column="">
        <div data-native-chat-row-key="m1">cat cat</div>
        <div data-native-chat-row-key="m2">cat cat</div>
      </div>
    </div>
  )
}

function mount(restoredQuery: string | null): {
  find: () => NativeChatFindMatches
  unmount: () => void
} {
  let latest: NativeChatFindMatches | null = null
  const view = render(
    <NativeChatViewTabContext value={TAB}>
      <Transcript restoredQuery={restoredQuery} report={(find) => (latest = find)} />
    </NativeChatViewTabContext>
  )
  return {
    find: () => {
      if (!latest) {
        throw new Error('not rendered')
      }
      return latest
    },
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
