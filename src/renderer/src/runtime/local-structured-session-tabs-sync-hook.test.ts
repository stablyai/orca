// @vitest-environment happy-dom

import { EVERY_AGENT_CHAT } from '../../../shared/native-chat/every-agent-chat.test-fixture'
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

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

function setStructuredChat(enabled: boolean): void {
  useAppStore.setState({
    settings: {
      ...useAppStore.getState().settings!,
      nativeChatProviders: enabled ? EVERY_AGENT_CHAT : {}
    }
  })
}

async function mountSync(): Promise<void> {
  renderHook(() => useLocalStructuredSessionTabsSync())
  // The host is asked whether it holds chats; its answer lands on the next tick.
  await act(async () => {
    await Promise.resolve()
  })
}

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

describe("this machine's structured chat mirror", () => {
  it('holds no session-tabs subscription for a machine that never held a chat', async () => {
    setStructuredChat(false)

    await mountSync()

    expect(mocks.start).not.toHaveBeenCalled()
  })

  // The setting picks what new agents open as; chats that already exist keep showing.
  it('mirrors the chats this machine holds with the setting off', async () => {
    setStructuredChat(false)
    mocks.held = true

    await mountSync()

    expect(mocks.start).toHaveBeenCalledOnce()
  })

  it('starts when a paired client creates the first chat here, without a restart', async () => {
    setStructuredChat(false)
    await mountSync()
    expect(mocks.start).not.toHaveBeenCalled()

    act(() => mocks.heldListeners.forEach((listener) => listener(true)))

    expect(mocks.start).toHaveBeenCalledOnce()
  })

  // Session history and phone launches build the host; only a chat answers true.
  it('stays off when the host is built for a machine that holds no chat', async () => {
    setStructuredChat(false)
    await mountSync()

    act(() => mocks.heldListeners.forEach((listener) => listener(false)))

    expect(mocks.start).not.toHaveBeenCalled()
  })

  it('keeps a change pushed while its first query was still in flight', async () => {
    setStructuredChat(false)
    let answer: (held: boolean) => void = () => undefined
    window.api.app.holdsStructuredAgentSessions = () =>
      new Promise<boolean>((resolve) => {
        answer = resolve
      })
    renderHook(() => useLocalStructuredSessionTabsSync())

    act(() => mocks.heldListeners.forEach((listener) => listener(true)))
    await act(async () => {
      answer(false)
      await Promise.resolve()
    })

    expect(mocks.start).toHaveBeenCalledOnce()
    const [{ isDisposed }] = mocks.start.mock.calls[0]
    expect(isDisposed()).toBe(false)
  })

  it('stays mirrored when the setting is turned off over chats this machine holds', async () => {
    setStructuredChat(true)
    mocks.held = true
    await mountSync()

    act(() => setStructuredChat(false))

    expect(mocks.start).toHaveBeenCalledOnce()
  })

  it('never runs in the browser client, which has no runtime of its own', async () => {
    mocks.isWebClient = true
    setStructuredChat(true)
    mocks.held = true

    await mountSync()

    expect(mocks.start).not.toHaveBeenCalled()
  })
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
