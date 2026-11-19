// @vitest-environment happy-dom
import { beforeEach, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => {
  const bots: unknown[] = []
  return { openUrl: vi.fn(), bots }
})
vi.mock('./bot-catalog-snapshot', () => ({ readBots: () => mocks.bots }))
vi.mock(
  '@/components/native-chat/links/actions/native-chat-http-link-source-owner',
  async (actual) => ({
    ...(await actual<object>()),
    // m4 air is paired but down: its workspace's browser can't host a page.
    resolveNativeChatHttpLinkSourceOwner: () => ({
      kind: 'runtime',
      runtimeEnvironmentId: 'env-1'
    }),
    canNativeChatOpenOwnedBrowser: () => false
  })
)

import { openBotHostPageOrSay } from './bot-host-page'

beforeEach(() => {
  mocks.openUrl.mockReset()
  Object.assign(window, { api: { shell: { openUrl: mocks.openUrl } } })
  mocks.bots = [{ id: 'cos', hostId: 'runtime:env-1', folderWorkspaceId: 'fw-1', name: 'CoS' }]
})

it("opens nothing in this computer's browser when the server's browser can't be reached", async () => {
  expect(
    openBotHostPageOrSay('runtime:env-1', 'https://api.slack.com/apps', { local: 'system' })
  ).toBe('unrouted')
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(mocks.openUrl).not.toHaveBeenCalled()
})
