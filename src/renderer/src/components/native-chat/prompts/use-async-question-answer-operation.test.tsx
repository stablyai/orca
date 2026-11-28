// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { useAppStore } from '@/store'
import type { Tab } from '../../../../../shared/workspace-layout/tab-groups/tab-types'
import {
  NativeChatViewTabContext,
  releaseNativeChatViewTabs
} from '../pane/ownership/native-chat-view-memory'
import { useAsyncQuestionAnswerOperation } from './NativeChatStructuredAsyncQuestion'

const TAB = { tabId: 'tab-1', worktreeId: 'wt-1' }

const inTab = ({ children }: { children: ReactNode }) => (
  <NativeChatViewTabContext value={TAB}>{children}</NativeChatViewTabContext>
)

beforeEach(() => {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: these checks read only a tab's id.
  useAppStore.setState({ unifiedTabsByWorktree: { [TAB.worktreeId]: [{ id: TAB.tabId } as Tab] } })
})
afterEach(() => {
  cleanup()
  releaseNativeChatViewTabs([TAB.tabId])
})

it('an answer still being sent holds its question when a released chat returns', () => {
  const first = renderHook(() => useAsyncQuestionAnswerOperation('scope'), { wrapper: inTab })
  act(() => first.result.current[1]({ promptKey: 'ask-1', inFlight: true }))
  first.unmount()
  const again = renderHook(() => useAsyncQuestionAnswerOperation('scope'), { wrapper: inTab })
  expect(again.result.current[0]).toEqual({ promptKey: 'ask-1', inFlight: true })
})
