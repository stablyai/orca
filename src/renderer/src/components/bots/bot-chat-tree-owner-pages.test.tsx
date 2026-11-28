// @vitest-environment happy-dom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type {
  BotChatTreeRead,
  BotChatTreeChat,
  BotChatTreeWorker
} from '../../../../shared/bots/bot-chat-tree'
import { replaceRuntimeEnvironmentRevisions } from '@/runtime/rpc/environment-revisions/runtime-environment-revision'
import { useAppStore } from '@/store'
import {
  automationOwnerBot,
  automationOwnerEnvironment
} from '../automations/hosts/automation-owner.test-fixture'
import { captureBotRecordOwner } from '../automations/hosts/bot-automation-row-owner'
import { useBotChatTree } from './use-bot-chat-tree'

const source = vi.hoisted(() => {
  const state: { read: BotChatTreeRead | null } = { read: null }
  return { state, refresh: vi.fn(), rpc: vi.fn() }
})
vi.mock('./use-bot-host-read', () => ({
  createBotHostRead: () => ({ request: source.refresh }),
  useBotHostRead: () => source.state.read
}))
vi.mock('./use-bot-host-read-state', () => ({
  useBotHostReadState: () => ({ state: 'ready', retry: source.refresh })
}))
vi.mock('@/runtime/rpc/calls/runtime-rpc-call', () => ({ callRuntimeRpc: source.rpc }))
vi.mock('@/app-shell/platform/paired-web-client-host', () => ({
  getPairedWebClientEnvironmentId: () => null
}))

const bot = automationOwnerBot('runtime:e')
const worker = (key: string, at: number): BotChatTreeWorker => ({
  key,
  title: key,
  state: 'done',
  startedAt: at,
  settledAt: at,
  dispatchId: key
})
function read(key: string, at: number): BotChatTreeRead {
  const qualify = captureBotRecordOwner(bot)
  const chat: BotChatTreeChat = {
    chatId: 'chat',
    title: 'Home',
    origin: 'home',
    live: 'idle',
    unread: false,
    closed: false,
    lastActiveAt: at,
    running: [],
    runningTotal: 0,
    finished: [qualify(worker(key, at))],
    finishedTotal: 10,
    failedTotal: 0
  }
  return { chats: [qualify(chat)], workspaceChats: {} }
}
function revision(value: number): void {
  replaceRuntimeEnvironmentRevisions([{ id: 'e', createdAt: 1, pairingRevision: value }], {
    retired: ['e'],
    sameHost: []
  })
  useAppStore.setState({ runtimeEnvironments: [automationOwnerEnvironment('e', value)] })
}
function hold<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
beforeEach(() => {
  vi.clearAllMocks()
  revision(4)
  source.state.read = read('old-base', 40)
})
afterEach(cleanup)

it('discards deeper pages and late replies on receiver replacement before traversing the new cursor', async () => {
  const pages: ReturnType<typeof hold<BotChatTreeRead>>[] = []
  source.rpc.mockImplementation(() => {
    const page = hold<BotChatTreeRead>()
    pages.push(page)
    return page.promise
  })
  const tree = renderHook(() => useBotChatTree(bot))
  act(() => tree.result.current.loadMore('chat'))
  await waitFor(() => expect(pages).toHaveLength(1))
  await act(async () => {
    pages[0].resolve(read('old-deep', 30))
  })
  expect(tree.result.current.chats[0].finished.map((row) => row.key)).toEqual([
    'old-base',
    'old-deep'
  ])
  act(() => tree.result.current.loadMore('chat'))
  await waitFor(() => expect(pages).toHaveLength(2))
  await act(async () => {
    revision(5)
  })
  expect(tree.result.current.chats[0].finished.map((row) => row.key)).toEqual(['old-base'])
  source.state.read = read('new-base', 50)
  tree.rerender()
  act(() => tree.result.current.loadMore('chat'))
  await waitFor(() => expect(pages).toHaveLength(3))
  expect(source.rpc.mock.calls[2][2].finishedAfter).toEqual({ at: 50, key: 'new-base' })
  await act(async () => {
    pages[1].resolve(read('obsolete-reply', 20))
  })
  expect(tree.result.current.chats[0].finished.map((row) => row.key)).toEqual(['new-base'])
  await act(async () => {
    pages[2].resolve(read('new-deep', 45))
  })
  expect(tree.result.current.chats[0].finished.map((row) => row.key)).toEqual([
    'new-base',
    'new-deep'
  ])
})
