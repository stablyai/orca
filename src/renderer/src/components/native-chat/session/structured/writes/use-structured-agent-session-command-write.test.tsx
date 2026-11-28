// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import type { Tab } from '../../../../../../../shared/workspace-layout/tab-groups/tab-types'
import {
  NativeChatViewTabContext,
  releaseNativeChatViewTabs
} from '../../../pane/ownership/native-chat-view-memory'
import { structuredAgentSessionSendsHeld } from '../delivery/structured-agent-session-pending-sends'
import type { StructuredAgentSessionWrite } from './use-structured-agent-session-mutate'
import { useStructuredAgentSessionCommandWrite } from './use-structured-agent-session-command-write'

const TAB = { tabId: 'tab-1', worktreeId: 'wt-1' }
const inTab = ({ children }: { children: ReactNode }) => (
  <NativeChatViewTabContext value={TAB}>{children}</NativeChatViewTabContext>
)

beforeEach(() => {
  vi.useFakeTimers()
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: these checks read only a tab's id.
  useAppStore.setState({ unifiedTabsByWorktree: { [TAB.worktreeId]: [{ id: TAB.tabId } as Tab] } })
})
afterEach(() => {
  cleanup()
  releaseNativeChatViewTabs([TAB.tabId])
  vi.useRealTimers()
})

it("an older host's /clear keeps sends held through a released view until the tab shows the new session", async () => {
  let reply = (_value: unknown): void => {}
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the clear reads only the outcome's kind and replacement id.
  const write = vi.fn(
    () => new Promise((resolve) => (reply = resolve))
  ) as unknown as StructuredAgentSessionWrite
  const view = (sessionId: string) =>
    renderHook(() => useStructuredAgentSessionCommandWrite(sessionId, write), { wrapper: inTab })
  const first = view('old')
  let cleared: Promise<unknown> = Promise.resolve()
  act(() => {
    cleared = first.result.current('clear')
  })
  // Released before the reply lands; the reply names a replacement the tab hasn't shown yet.
  first.unmount()
  await act(async () => {
    reply({ kind: 'done', value: { replacementSessionId: 'new' } })
    await cleared
  })
  expect(structuredAgentSessionSendsHeld('old')).toBe(true)
  view('old').unmount()
  expect(structuredAgentSessionSendsHeld('old')).toBe(true)
  // The tab moves to the new session: its view ends the old hold.
  view('new')
  expect(structuredAgentSessionSendsHeld('old')).toBe(false)
})

it("an older host's /clear keeps sends held when its session's view remounts before the reply", async () => {
  let reply = (_value: unknown): void => {}
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the clear reads only the outcome's kind and replacement id.
  const write = vi.fn(
    () => new Promise((resolve) => (reply = resolve))
  ) as unknown as StructuredAgentSessionWrite
  const view = (sessionId: string) =>
    renderHook(() => useStructuredAgentSessionCommandWrite(sessionId, write), { wrapper: inTab })
  const first = view('old')
  let cleared: Promise<unknown> = Promise.resolve()
  act(() => {
    cleared = first.result.current('clear')
  })
  first.unmount()
  view('old')
  await act(async () => {
    reply({ kind: 'done', value: { replacementSessionId: 'new' } })
    await cleared
  })
  expect(structuredAgentSessionSendsHeld('old')).toBe(true)
})
