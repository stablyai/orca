import { describe, expect, it, vi } from 'vitest'
import { importReleaseCheckoutModule, materializeReleaseCheckout } from './release-checkout'
import {
  HOST_TEST_SESSION,
  HOST_TEST_NOW
} from '../../../src/main/native-chat/agent-session-wire/structured-agent-session-host-test-data'
import {
  WORKTREE,
  createChat,
  clear,
  snapshot
} from '../../../src/main/runtime/rpc/methods/structured-chat-tab-table.test-fixture'

describe('historical clients after a clear', () => {
  it.each(['v1.4.222', 'b6b4d68cd844c921c7c5191cef72d5adafc0dafa'])(
    '%s mirrors the actual published tab without changing pane or conversation identity',
    async (ref) => {
      const checkout = await materializeReleaseCheckout(ref)
      vi.doMock(`${checkout.root}/src/renderer/src/runtime/web-runtime-session.ts`, () => ({
        HOST_TERMINAL_SURFACE_SEPARATOR: '::',
        WEB_TERMINAL_SURFACE_TAB_PREFIX: 'web-terminal:',
        toWebTerminalSurfaceTabId: (id: string) => id
      }))
      vi.doMock(`${checkout.root}/src/renderer/src/runtime/runtime-terminal-stream.ts`, () => ({
        getRemoteRuntimePtyEnvironmentId: () => null
      }))
      const module = await importReleaseCheckoutModule(
        checkout,
        'src/renderer/src/runtime/web-session-tabs-sync/terminal-surfaces.ts'
      )
      const build = module.buildMirroredAgentTabs
      if (typeof build !== 'function') {
        throw new Error('historical agent tab mirror missing')
      }
      expect(await createChat(HOST_TEST_SESSION)).toMatchObject({ ok: true })
      const localTabs = [
        {
          id: 'existing-local-pane',
          entityId: HOST_TEST_SESSION,
          contentType: 'agent-session',
          agentSessionAgent: 'codex',
          worktreeId: WORKTREE,
          groupId: 'existing-local-group',
          label: 'Codex Chat',
          customLabel: 'My conversation',
          color: null,
          createdAt: HOST_TEST_NOW,
          sortOrder: 0,
          isPinned: true
        }
      ]
      const mirror = async () =>
        build(await snapshot(), 'remote-host', new Map(), 'fallback', 0, localTabs, HOST_TEST_NOW)
      const before = await mirror()
      await clear(HOST_TEST_SESSION)
      expect(await mirror()).toEqual(before)
      expect(await mirror()).toMatchObject([
        {
          hostTabId: `agent-session:${HOST_TEST_SESSION}`,
          unifiedTab: {
            id: 'existing-local-pane',
            entityId: HOST_TEST_SESSION,
            groupId: 'existing-local-group',
            customLabel: 'My conversation',
            isPinned: true
          }
        }
      ])
    },
    300_000
  )
})
