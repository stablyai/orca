import { expect, it, vi } from 'vitest'
import { parseBotDeepLink } from '../../../shared/bot-deep-link'
import { openBotLinkHome } from './bot-link-open'

vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => ({ startupWorktreeRefreshCompleted: true }),
    subscribe: () => () => {}
  }
}))
vi.mock('@/i18n/i18n', () => ({}))
vi.mock('@/runtime/rpc/calls/runtime-rpc-call', () => ({}))
vi.mock('./bot-access-requests', () => ({}))
vi.mock('./agent-session/open/activate-ai-vault-structured-session', () => ({}))
vi.mock('./agent-session/open/open-existing-structured-session', () => ({}))
vi.mock('./agent-session/structured-agent-session-tab-activation', () => ({}))

const catalog = vi.hoisted(() => {
  const hostId = 'runtime:paired-server'
  return {
    hostId,
    bot: { id: 'scan-bot', hostId, folderWorkspaceId: 'bot-home' },
    active: { worktreeId: 'initial-worktree', hostId: 'local' }
  }
})

vi.mock('./bot-catalog-snapshot', () => ({
  readBotHostIds: () => ['local', catalog.hostId],
  readBotHostState: () => 'live',
  readHostBots: (hostId: string) => (hostId === catalog.hostId ? [catalog.bot] : []),
  readUpdateNeededBotHosts: () => []
}))

vi.mock('./bot-catalog', () => ({
  refreshBots: async () => {},
  openBotHomeTab: async () => {
    catalog.active = { worktreeId: 'folder:bot-home', hostId: catalog.hostId }
    return true
  }
}))

vi.mock('./workspace/activation/worktree-activation', () => ({
  activateAndRevealWorkspaceWithOutcome: (
    worktreeId: string,
    options: { executionHostId?: string }
  ) => {
    catalog.active = { worktreeId, hostId: options.executionHostId ?? 'local' }
    return { opened: { primaryTabId: null } }
  }
}))

it('opens a paired bot’s workspace in the receiving client', async () => {
  const link = parseBotDeepLink('orca://bot/scan-bot?workspace=repo-id%3A%3A%2Fworkspaces%2Fscan')
  if (!link) {
    throw new Error('Expected the bot URL to parse')
  }
  await openBotLinkHome(link.botId, link.conversation ?? null, link.workspace)
  expect(catalog.active).toEqual({
    worktreeId: 'repo-id::/workspaces/scan',
    hostId: 'runtime:paired-server'
  })
})
