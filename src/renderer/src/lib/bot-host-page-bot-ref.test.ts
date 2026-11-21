// @vitest-environment happy-dom
import { beforeEach, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => {
  const bots: unknown[] = []
  const opened: string[] = []
  return { bots, opened, toastError: vi.fn() }
})
vi.mock('./bot-catalog-snapshot', () => ({ readBots: () => mocks.bots }))
vi.mock('sonner', () => ({ toast: { error: mocks.toastError } }))
vi.mock(
  '@/components/native-chat/links/actions/native-chat-http-link-source-owner',
  async (actual) => ({
    ...(await actual<object>()),
    resolveNativeChatHttpLinkSourceOwner: () => ({ kind: 'runtime', runtimeEnvironmentId: 'env-1' })
  })
)
vi.mock('./browser/workspace/workspace-browser-route-eligibility', async (actual) => ({
  ...(await actual<object>()),
  canOpenWorkspaceBrowserTabOnRuntime: () => true
}))
vi.mock('./browser/navigation/app-http-link-open', async (actual) => ({
  ...(await actual<object>()),
  openAppHttpLink: (_url: string, options: { worktreeId: string }) => {
    mocks.opened.push(options.worktreeId)
    return 'orca-browser'
  }
}))

import { openBotHostPageOrSay } from './bot-host-page'

const URL = 'https://accounts.google.com/o/oauth2/auth'

beforeEach(() => {
  mocks.opened.length = 0
  mocks.toastError.mockReset()
  mocks.bots = [{ id: 'rex', hostId: 'runtime:env-1', folderWorkspaceId: 'fw-rex', name: 'Rex' }]
})

it("opens a named agent's page only in that agent's workspace, and says when it's gone", () => {
  const ivy = { id: 'ivy', hostId: 'runtime:env-1' } as const
  expect(openBotHostPageOrSay('runtime:env-1', URL, { local: 'system', bot: ivy })).toBe('unrouted')
  expect(mocks.opened).toEqual([])
  expect(mocks.toastError).toHaveBeenCalledWith(
    expect.stringContaining('workspace isn’t available')
  )

  // With no agent named, any agent of the host lends its workspace, as before.
  expect(openBotHostPageOrSay('runtime:env-1', URL, { local: 'system' })).toBe('orca-browser')
  expect(mocks.opened).toEqual(['folder:fw-rex'])
})
