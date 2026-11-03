// @vitest-environment happy-dom

import '../../../shared/native-chat/every-agent-chat.test-fixture'
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  start: vi.fn(async (_sync: { isDisposed: () => boolean }) => undefined),
  held: false,
  isWebClient: false,
  heldListeners: new Array<(held: boolean) => void>()
}))

vi.mock('./local-structured-session-tabs-sync/subscription', () => ({
  startLocalStructuredSessionTabsSync: mocks.start
}))
vi.mock('@/lib/web-client-location', () => ({ isWebClientLocation: () => mocks.isWebClient }))

import { useAppStore } from '../store'
import { useLocalStructuredSessionTabsSync } from './local-structured-session-tabs-sync'
import {
  resetLocalStructuredChatsForTests,
  useLocalStructuredChatsInUse
} from './local-structured-chats'

beforeEach(() => {
  mocks.start.mockClear()
  mocks.held = false
  mocks.isWebClient = false
  mocks.heldListeners.splice(0)
  resetLocalStructuredChatsForTests()
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      app: {
        holdsStructuredAgentSessions: vi.fn(async () => mocks.held),
        onStructuredAgentSessionsHeldChanged: vi.fn((listener: (held: boolean) => void) => {
          mocks.heldListeners.push(listener)
          return () => undefined
        })
      }
    }
  })
  useAppStore.setState({ workspaceSessionReady: true, terminalStartupRestorationReady: true })
})

afterEach(() => {
  cleanup()
  resetLocalStructuredChatsForTests()
  useAppStore.setState(useAppStore.getInitialState(), true)
})

it.each([100, 1000])('bounds root preference work for %i choices', async (size) => {
  let reads = 0
  const choicesFor = (on: boolean): Record<string, boolean> => {
    const choices: Record<string, boolean> = {}
    for (let index = 0; index < size; index++) {
      Object.defineProperty(choices, `agent-${index}`, {
        enumerable: true,
        get: () => {
          reads++
          return on && index === size - 1
        }
      })
    }
    return choices
  }
  const choices = choicesFor(false)
  useAppStore.setState({
    settings: { ...useAppStore.getState().settings!, nativeChatProviders: choices }
  })
  const renders = vi.fn()
  renderHook(() => {
    renders(useLocalStructuredChatsInUse())
    useLocalStructuredSessionTabsSync()
  })
  await act(async () => {
    await Promise.resolve()
  })
  const initialRenders = renders.mock.calls.length
  reads = 0
  act(() => useAppStore.setState({ activeRepoId: 'unrelated-repo' }))
  expect(renders).toHaveBeenCalledTimes(initialRenders)
  // Two root consumers each enumerate exactly this map; no per-chat acquisition or fanout.
  expect(reads).toBe(2 * size)
  expect(mocks.start).not.toHaveBeenCalled()
  act(() =>
    useAppStore.setState({
      settings: {
        ...useAppStore.getState().settings!,
        nativeChatProviders: choicesFor(true)
      }
    })
  )
  expect(mocks.start).toHaveBeenCalledOnce()
  expect(renders).toHaveBeenLastCalledWith(true)
  const onRenders = renders.mock.calls.length
  act(() =>
    useAppStore.setState({
      settings: {
        ...useAppStore.getState().settings!,
        nativeChatProviders: choicesFor(true)
      }
    })
  )
  expect(renders).toHaveBeenCalledTimes(onRenders)
  expect(mocks.start).toHaveBeenCalledOnce()
  act(() =>
    useAppStore.setState({
      settings: {
        ...useAppStore.getState().settings!,
        agentDefaultSurface: 'chat',
        nativeChatProviders: choicesFor(false)
      }
    })
  )
  reads = 0
  act(() => useAppStore.setState({ activeRepoId: 'another-unrelated-repo' }))
  expect(reads).toBe(0)
  expect(renders).toHaveBeenCalledTimes(onRenders)
  expect(mocks.start).toHaveBeenCalledOnce()
})
