// Paired-owned browser/chat layouts bypass local main in both builds. SSH worktree layout remains local-main-owned but lacks a structured-chat host.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'
import type * as RpcClientModule from '@/runtime/runtime-rpc-client'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../../shared/layout-owner-switch'
import { toRuntimeExecutionHostId, toSshExecutionHostId } from '../../../../shared/execution-host'
import { layoutApplyTestTransport } from '@/runtime/layout-apply-test-transport.test-fixture'
import { createTestStore, makeWorktree, seedStore } from './store-test-helpers'
import { createStoreCascadesMockApi } from './store-cascades-test-harness'
import { drawTabsFromMain, type TabsDrawnFromMain } from './tabs-drawn-from-main.test-fixture'

const mocks = vi.hoisted(() => ({
  store: ((): unknown => null)(),
  hostCalls: ((): { target: RuntimeClientTarget; method: string }[] => [])()
}))

vi.mock('@/runtime/runtime-rpc-client', async (importOriginal) => {
  const actual = await importOriginal<typeof RpcClientModule>()
  return {
    ...actual,
    callRuntimeRpc: (target: RuntimeClientTarget, method: string, params?: unknown) => {
      if (target.kind === 'local' && method === 'layout.apply') {
        return layoutApplyTestTransport.call(params)
      }
      mocks.hostCalls.push({ target, method })
      return Promise.resolve({ ok: true })
    },
    ensureRuntimeEnvironmentCompatible: vi.fn(async () => undefined)
  }
})
vi.mock('@/runtime/runtime-layout-client', async (importOriginal) =>
  (
    await import('@/runtime/layout-apply-test-transport.test-fixture')
  ).runtimeLayoutClientWithTestFrames(await importOriginal())
)
vi.mock('@/store', () => ({
  get useAppStore() {
    return mocks.store
  }
}))
vi.mock('sonner', () => ({
  toast: { info: vi.fn(), success: vi.fn(), error: vi.fn(), warning: vi.fn() }
}))

createStoreCascadesMockApi()

import { openStructuredAgentSessionProvisionalTab } from '@/lib/structured-agent-session-launch-surface'

const SERVER = 'server-1'
const SERVER_WT = 'repo-s::/srv/app'
const LOCAL_WT = 'repo-l::/work/app'
const SSH_WT = 'repo-h::/home/app'
const SSH_HOST = toSshExecutionHostId('box')

let store: ReturnType<typeof createTestStore>
let main: TabsDrawnFromMain

function group(worktreeId: string) {
  return [{ id: `group-${worktreeId}`, worktreeId, activeTabId: null, tabOrder: [] }]
}

beforeEach(async () => {
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  mocks.hostCalls = []
  store = createTestStore()
  mocks.store = store
  seedStore(store, {
    worktreesByRepo: {
      'repo-s': [
        makeWorktree({
          id: SERVER_WT,
          repoId: 'repo-s',
          path: '/srv/app',
          hostId: toRuntimeExecutionHostId(SERVER)
        })
      ],
      'repo-l': [makeWorktree({ id: LOCAL_WT, repoId: 'repo-l', path: '/work/app' })],
      'repo-h': [
        makeWorktree({ id: SSH_WT, repoId: 'repo-h', path: '/home/app', hostId: SSH_HOST })
      ]
    },
    activeWorktreeId: SERVER_WT,
    groupsByWorktree: {
      [SERVER_WT]: group(SERVER_WT),
      [LOCAL_WT]: group(LOCAL_WT),
      [SSH_WT]: group(SSH_WT)
    },
    activeGroupIdByWorktree: {
      [SERVER_WT]: `group-${SERVER_WT}`,
      [LOCAL_WT]: `group-${LOCAL_WT}`,
      [SSH_WT]: `group-${SSH_WT}`
    },
    layoutByWorktree: {
      [SERVER_WT]: { type: 'leaf', groupId: `group-${SERVER_WT}` },
      [LOCAL_WT]: { type: 'leaf', groupId: `group-${LOCAL_WT}` },
      [SSH_WT]: { type: 'leaf', groupId: `group-${SSH_WT}` }
    },
    unifiedTabsByWorktree: { [SERVER_WT]: [], [LOCAL_WT]: [], [SSH_WT]: [] }
  })
  main = await drawTabsFromMain(store)
})

afterEach(() => {
  main.close()
})

const tabsOf = (worktreeId: string) => store.getState().unifiedTabsByWorktree[worktreeId] ?? []
const sentFor = (worktreeId: string) =>
  layoutApplyTestTransport.sent.filter((command) => command.workspace === worktreeId)

describe("a paired server's workspace", () => {
  it('opens and closes a browser tab without main', async () => {
    const browserTab = store.getState().createBrowserTab(SERVER_WT, 'https://example.com')
    await main.settle()
    const drawn = tabsOf(SERVER_WT).find((tab) => tab.entityId === browserTab.id)
    expect(drawn).toMatchObject({ contentType: 'browser' })

    store.getState().closeBrowserTab(browserTab.id)
    await main.settle()

    expect(tabsOf(SERVER_WT).some((tab) => tab.entityId === browserTab.id)).toBe(false)
    expect(sentFor(SERVER_WT)).toEqual([])
  })

  it('opens and closes a chat tab without main', async () => {
    const chat = openStructuredAgentSessionProvisionalTab({
      worktreeId: SERVER_WT,
      executionHostId: toRuntimeExecutionHostId(SERVER),
      sessionId: 'chat-1',
      agent: 'codex'
    })
    await main.settle()
    expect(tabsOf(SERVER_WT).map((tab) => tab.id)).toEqual([chat.id])

    store.getState().closeUnifiedTab(chat.id)
    await main.settle()

    expect(tabsOf(SERVER_WT)).toEqual([])
    expect(sentFor(SERVER_WT)).toEqual([])
    // The close still reaches the server that runs the chat.
    await vi.waitFor(() =>
      expect(mocks.hostCalls).toContainEqual({
        target: { kind: 'environment', environmentId: SERVER },
        method: 'session.tabs.close'
      })
    )
  })

  it.skipIf(!ORCA_LAYOUT_OWNER_IS_MAIN)(
    "presence: this machine's workspace sends the same opens and closes to main",
    async () => {
      const browserTab = store.getState().createBrowserTab(LOCAL_WT, 'https://example.com')
      await main.settle()
      store.getState().closeBrowserTab(browserTab.id)
      const chat = openStructuredAgentSessionProvisionalTab({
        worktreeId: LOCAL_WT,
        executionHostId: 'local',
        sessionId: 'chat-2',
        agent: 'codex'
      })
      await main.settle()
      store.getState().closeUnifiedTab(chat.id)
      await main.settle()

      expect(sentFor(LOCAL_WT).map((command) => command.type)).toEqual([
        'openBrowserTab',
        'closeTabs',
        'openAgentSessionTab',
        'closeTabs'
      ])
    }
  )
})
