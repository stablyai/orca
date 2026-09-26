// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { useAutoAckViewedAgent } from './useAutoAckViewedAgent'
import { useAppStore } from '@/store'
import { makeTabGroup, makeUnifiedTab } from '@/store/slices/store-test-helpers'
import type { Tab } from '../../../shared/tab-types'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})
it('keeps pointer movement over an already-read chat independent of other workspaces', () => {
  vi.stubGlobal('__ORCA_WEB_CLIENT__', true)
  vi.spyOn(document, 'hasFocus').mockReturnValue(true)
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
  useAppStore.setState(useAppStore.getInitialState(), true)
  const unifiedTabsByWorktree: Record<string, Tab[]> = {}
  let reads = 0
  for (let index = 0; index < 250; index += 1) {
    const id = `chat-${index}`
    const tab = makeUnifiedTab({
      id,
      worktreeId: `wt-${index}`,
      groupId: 'group',
      contentType: 'agent-session',
      entityId: `session-${index}`,
      agentSessionAgent: 'claude'
    })
    Object.defineProperty(tab, 'id', {
      get() {
        reads += 1
        return id
      },
      enumerable: true
    })
    unifiedTabsByWorktree[`wt-${index}`] = [tab]
  }
  useAppStore.setState({
    activeView: 'terminal',
    activeWorktreeId: 'wt-249',
    activeTabId: null,
    activeGroupIdByWorktree: { 'wt-249': 'group' },
    groupsByWorktree: {
      'wt-249': [
        makeTabGroup({
          id: 'group',
          worktreeId: 'wt-249',
          activeTabId: 'chat-249',
          tabOrder: ['chat-249']
        })
      ]
    },
    unifiedTabsByWorktree
  })
  renderHook(() => useAutoAckViewedAgent(false))
  const before = useAppStore.getState()
  reads = 0
  const input = new Event('pointermove')
  Object.defineProperty(input, 'isTrusted', { value: true })
  act(() => {
    for (let move = 0; move < 100; move += 1) {
      window.dispatchEvent(input)
    }
  })
  expect(useAppStore.getState()).toBe(before)
  expect(reads).toBeLessThan(1_000)
})
